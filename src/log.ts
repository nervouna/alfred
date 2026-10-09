const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.ALFRED_LOG as Level | undefined) ?? "info"] ?? LEVELS.info;

function emit(level: Level, msg: string): void {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (LEVELS[level] >= LEVELS.warn) console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string) => emit("debug", msg),
  info: (msg: string) => emit("info", msg),
  warn: (msg: string) => emit("warn", msg),
  error: (msg: string) => emit("error", msg),
};

const SECRET_FIELDS = /"(context_token|bot_token|typing_ticket|aes_key|aeskey|token)"\s*:\s*"[^"]*"/g;

/** Mask credential-bearing JSON fields and truncate for logging. */
export function redact(body: string, maxLen = 800): string {
  const masked = body.replace(SECRET_FIELDS, '"$1":"***"');
  return masked.length <= maxLen ? masked : `${masked.slice(0, maxLen)}…(${masked.length} chars)`;
}

/** Show only the edges of an identifier or token. */
export function mask(value: string | undefined): string {
  if (!value) return "(none)";
  return value.length <= 8 ? "***" : `${value.slice(0, 4)}…${value.slice(-4)}`;
}
