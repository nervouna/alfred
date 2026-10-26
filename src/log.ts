import fs from "node:fs";
import path from "node:path";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.ALFRED_LOG as Level | undefined) ?? "info"] ?? LEVELS.info;
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;

let sink: { file: string; bytes: number } | undefined;

/** Also append log lines to `file`, for the workbench's logs view. Past 5 MB it moves to `<file>.1`. */
export function logToFile(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let bytes = 0;
  try {
    bytes = fs.statSync(file).size;
  } catch {
    // A new file.
  }
  sink = { file, bytes };
}

function appendToSink(line: string): void {
  if (!sink) return;
  try {
    if (sink.bytes > LOG_FILE_MAX_BYTES) {
      fs.renameSync(sink.file, `${sink.file}.1`);
      sink.bytes = 0;
    }
    fs.appendFileSync(sink.file, `${line}\n`, { mode: 0o600 });
    sink.bytes += Buffer.byteLength(line) + 1;
  } catch (err) {
    const file = sink.file;
    sink = undefined;
    console.error(`writing the log file ${file} failed, stopped writing it: ${describeError(err)}`);
  }
}

function emit(level: Level, msg: string): void {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (LEVELS[level] >= LEVELS.warn) console.error(line);
  else console.log(line);
  appendToSink(line);
}

export const log = {
  debug: (msg: string) => emit("debug", msg),
  info: (msg: string) => emit("info", msg),
  warn: (msg: string) => emit("warn", msg),
  error: (msg: string) => emit("error", msg),
};

/** Error message plus its cause chain; undici's "fetch failed" hides the real reason in `cause`. */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 4; depth++) {
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      parts.push(code ? `${current.message} [${code}]` : current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" <- ");
}

/** Show only the edges of an identifier or token. */
export function mask(value: string | undefined): string {
  if (!value) return "(none)";
  return value.length <= 8 ? "***" : `${value.slice(0, 4)}…${value.slice(-4)}`;
}
