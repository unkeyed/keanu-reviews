type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACTED = "[redacted]";
const secretKeys = new Set<string>();
const secretValues = new Set<string>();

export function registerSecrets(secrets: {
  keys: Iterable<string>;
  values?: Iterable<string | undefined>;
}): void {
  for (const k of secrets.keys) secretKeys.add(k);
  for (const v of secrets.values ?? []) {
    if (v && v.length >= 8) secretValues.add(v);
  }
}

function redact(value: unknown, key?: string): unknown {
  if (key && secretKeys.has(key)) return REDACTED;
  if (typeof value === "string") {
    return secretValues.has(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k);
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(level: LogLevel = "info", base: Record<string, unknown> = {}): Logger {
  const threshold = LEVEL_ORDER[level];

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const line = redact({ level: lvl, msg, ...base, ...fields }) as Record<string, unknown>;
    const sink = lvl === "error" || lvl === "warn" ? console.error : console.log;
    sink(JSON.stringify(line));
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (bindings) => createLogger(level, { ...base, ...bindings }),
  };
}
