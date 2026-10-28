// The settings command of the command API (see SettingsCommands in src/api/server.ts) on the settings store and the
// agent handler's model switch. The other settings go to the store; the model goes first to the handler, which keeps it
// in agent-state.json and moves a live query to it, and the store's update after it announces the whole change once.

import { DEFAULT_MODEL } from "../agent/config.ts";
import type { ModelKey } from "../agent/config.ts";
import type { SettingsCommands } from "../api/server.ts";
import { InvalidSettings, checkChanges } from "./store.ts";
import type { SettingsChanges, SettingsStore } from "./store.ts";

/** The agent handler's model switch: what /model does. */
export interface ModelSwitch {
  setModel(key: ModelKey): Promise<unknown>;
}

export function settingsCommands(store: SettingsStore, handler: ModelSwitch): SettingsCommands {
  return {
    update: async (command) => {
      const { type: _type, model, reset, ...values } = command;
      // Resetting the model means the default one.
      const switchTo = model ?? (reset?.includes("model") ? DEFAULT_MODEL : undefined);
      const stored = reset?.filter((key) => key !== "model");
      const changes: SettingsChanges = { ...values, ...(stored?.length ? { reset: stored } : {}) };
      try {
        // Checked before the model moves, so a refused command changes nothing.
        checkChanges(changes);
        if (switchTo !== undefined && switchTo !== store.get().model) {
          try {
            await handler.setModel(switchTo);
          } catch (err) {
            // The key may be stored already: tell the owner's clients which model the chat is on.
            store.refresh();
            throw err;
          }
        }
        return { ok: true, settings: store.update(changes) };
      } catch (err) {
        if (err instanceof InvalidSettings) return { ok: false, status: 400, error: err.message };
        throw err;
      }
    },
  };
}
