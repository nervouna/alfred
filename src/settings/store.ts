// The settings the owner can change while Alfred runs. A setting is, in this order of precedence, the owner's override,
// the environment variable and the built-in default; the model is the exception, kept in agent-state.json as /model
// always did, and read here through a getter. This store is the only writer of two files:
//   - $STATE_DIR/settings.json: the owner's overrides, nothing else (a partial object);
//   - $STATE_DIR/workbench/settings.json: the effective Settings with `overridden`, rewritten at startup and on every
//     change. The workbench is a process of its own that does not see Alfred's environment, so this is where it reads
//     the effective values.
// Every change of an effective value is appended to the event log as settings.updated with the whole Settings. The
// write ranges of the contract (src/api/schema.ts) bind what the owner writes, not what the environment says. Nothing
// the agent can reach writes here: the files are outside the workspace and the command API is a socket it cannot reach.

import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { DEFAULT_MODEL, type EnvSettings, type ModelKey, envSettings } from "../agent/config.ts";
import { SettingKeySchema, type SettingKey, type Settings, SettingsUpdateSchema } from "../api/schema.ts";
import { type EventLog, sharedEventLog } from "../events.ts";
import { describeError, log } from "../log.ts";
import { WORKBENCH_STATE_DIR } from "../runs.ts";
import { STATE_DIR, readJson, writeJson } from "../store.ts";

/** The owner's overrides. */
export const SETTINGS_FILE = path.join(STATE_DIR, "settings.json");
/** The effective settings, for the workbench to read. */
export const SETTINGS_MIRROR_FILE = path.join(WORKBENCH_STATE_DIR, "settings.json");

/** Every setting but the model, in the table's order: the ones this store keeps. */
type StoredKey = keyof EnvSettings;
const KEYS: readonly SettingKey[] = SettingKeySchema.options;
const STORED_KEYS = KEYS.filter((key): key is StoredKey => key !== "model");

type Overrides = Partial<EnvSettings>;

/** A change the contract's write ranges do not allow, or one this store cannot make. Its message is for the owner's client. */
export class InvalidSettings extends Error {}

/**
 * What a change sets: each setting named is set to that value (`ideasAt: null` turns the daily generation off), and
 * `reset` returns its keys to what the environment and the built-in defaults give. The model is not here: it is switched
 * by the agent handler, which then tells this store (refresh).
 */
export type SettingsChanges = Partial<EnvSettings> & { reset?: readonly StoredKey[] };

export interface SettingsStoreOptions {
  /** The overrides file. By default settings.json in the state directory. */
  file?: string;
  /** The effective settings for the workbench. By default workbench/settings.json in the state directory. */
  mirror?: string;
  events?: EventLog;
  /** The environment layer, read once when the store is made: it throws, naming the variable, on a malformed one. By default the process's environment. */
  env?: () => EnvSettings;
  /** The model the chat runs on, from agent-state.json. Until a source is given (useModel) it is the default. */
  model?: () => ModelKey;
}

/** Told after a change has been saved and logged: the settings now, and the settings before. */
export type ChangeListener = (settings: Settings, previous: Settings) => void;

const isStoredKey = (key: string): key is StoredKey => (STORED_KEYS as readonly string[]).includes(key);

/** Why `key` is not a setting this store keeps, or undefined when it is one. */
function unkept(key: string): string | undefined {
  if (isStoredKey(key)) return undefined;
  return key === "model" ? "the model is not kept here" : "not a setting";
}

/** Why the value is not a valid override of the stored setting `key`, or undefined when it is. The ranges are the command's own. */
function outOfRange(key: StoredKey, value: unknown): string | undefined {
  const parsed = SettingsUpdateSchema.safeParse({ type: "settings.update", [key]: value });
  if (parsed.success) return undefined;
  const [issue] = parsed.error.issues;
  return issue?.message ?? "invalid";
}

/** Checks a change against the contract's write ranges. Throws InvalidSettings, naming the key. */
export function checkChanges(changes: SettingsChanges): void {
  const { reset = [], ...values } = changes;
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const problem = unkept(key) ?? outOfRange(key as StoredKey, value);
    if (problem) throw new InvalidSettings(`${key}: ${problem}`);
  }
  for (const key of reset) {
    const problem = unkept(key);
    if (problem) throw new InvalidSettings(`reset: ${key}: ${problem}`);
    if (values[key] !== undefined) throw new InvalidSettings(`${key}: cannot be set and reset together`);
  }
}

export class SettingsStore {
  private readonly file: string;
  private readonly mirror: string;
  private readonly events: EventLog;
  private readonly env: EnvSettings;
  private model: () => ModelKey;
  private overrides: Overrides;
  /** The settings as last written to the mirror (and, but for the startup one, announced). */
  private announced: Settings;
  private readonly listeners = new Set<ChangeListener>();

  constructor({ file = SETTINGS_FILE, mirror = SETTINGS_MIRROR_FILE, events = sharedEventLog(), env = envSettings, model = () => DEFAULT_MODEL }: SettingsStoreOptions = {}) {
    this.file = file;
    this.mirror = mirror;
    this.events = events;
    this.env = env();
    this.model = model;
    this.overrides = loadOverrides(file);
    this.announced = this.get();
    this.writeMirror(this.announced);
  }

  /** The effective settings now: the owner's overrides over the environment over the built-in defaults, the model from its source. */
  get(): Settings {
    return this.compute(this.overrides);
  }

  /**
   * Gives the store its source of the model, which lives in the agent handler's state. The mirror is rewritten with it
   * if it differs; no event, since the model was not changed.
   */
  useModel(model: () => ModelKey): void {
    this.model = model;
    const settings = this.get();
    if (isDeepStrictEqual(settings, this.announced)) return;
    this.announced = settings;
    this.writeMirror(settings);
  }

  /**
   * Calls the listener after every change of an effective value (update(), or refresh() finding the model changed), once
   * it is saved and logged. A listener that throws is logged and does not fail the change. Returns a function that stops
   * the listening.
   */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /**
   * Applies a change: the settings it names are set, the keys in `reset` return to the lower layers. A value equal to the
   * one the environment gives is no override, so the setting follows the environment again. When no effective value ends up
   * different, nothing is written and nothing is announced. Otherwise the overrides are saved, then the mirror, the event
   * log and the listeners hear of it. Returns the settings now. Throws InvalidSettings for a value outside the write
   * ranges, and the error of a save that fails, leaving everything as it was.
   */
  update(changes: SettingsChanges): Settings {
    checkChanges(changes);
    const next: Record<string, unknown> = { ...this.overrides };
    for (const key of changes.reset ?? []) delete next[key];
    for (const key of STORED_KEYS) {
      const value = changes[key];
      if (value === undefined) continue;
      if (isDeepStrictEqual(value, this.env[key])) delete next[key];
      else next[key] = value;
    }
    const settings = this.compute(next as Overrides);
    if (isDeepStrictEqual(settings, this.announced)) return this.get();
    // The model may have changed since the last announcement, with the overrides as they were.
    if (!isDeepStrictEqual(next, this.overrides)) {
      writeJson(this.file, next);
      this.overrides = next as Overrides;
    }
    this.announce(settings);
    return settings;
  }

  /**
   * Announces the settings if an effective value differs from the last announced one. The agent handler calls it after
   * any change of the model; the comparison makes a call that changed nothing harmless.
   */
  refresh(): Settings {
    const settings = this.get();
    if (!isDeepStrictEqual(settings, this.announced)) this.announce(settings);
    return settings;
  }

  private compute(overrides: Overrides): Settings {
    const model = this.model();
    const values: EnvSettings = { ...this.env, ...overrides };
    const overridden = KEYS.filter((key) =>
      key === "model" ? model !== DEFAULT_MODEL : overrides[key] !== undefined && !isDeepStrictEqual(overrides[key], this.env[key]),
    );
    return { model, ...values, overridden };
  }

  /** Rewrites the mirror, appends the event and tells the listeners. */
  private announce(settings: Settings): void {
    const previous = this.announced;
    this.announced = settings;
    this.writeMirror(settings);
    this.events.append("settings.updated", settings);
    for (const listener of this.listeners) {
      try {
        listener(settings, previous);
      } catch (err) {
        log.error(`a listener of the settings changing failed: ${describeError(err)}`);
      }
    }
  }

  /** The workbench would show the old values; that is logged, not a reason to refuse the owner's change or to stop startup. */
  private writeMirror(settings: Settings): void {
    try {
      writeJson(this.mirror, settings);
    } catch (err) {
      log.error(`writing ${this.mirror} failed: ${describeError(err)}`);
    }
  }
}

/**
 * The overrides in the file. A bad file must never keep Alfred from starting, or the owner could not repair it from the app:
 * a file that is missing holds none; one that cannot be read, is not JSON or is not an object is treated as empty, with a
 * warning, and left for the next change to replace; an override that is unknown or outside the write ranges is dropped with
 * a warning naming the key, and the rest are kept.
 */
function loadOverrides(file: string): Overrides {
  let raw: unknown;
  try {
    raw = readJson<unknown>(file);
  } catch (err) {
    log.warn(`${file} cannot be used, so no setting is overridden until the next change replaces it: ${describeError(err)}`);
    return {};
  }
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    log.warn(`${file} does not hold an object, so no setting is overridden until the next change replaces it`);
    return {};
  }
  const overrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const problem = unkept(key) ?? outOfRange(key as StoredKey, value);
    if (problem) log.warn(`${file}: dropping the override ${JSON.stringify(key)}: ${problem}`);
    else overrides[key] = value;
  }
  return overrides as Overrides;
}
