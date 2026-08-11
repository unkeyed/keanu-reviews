import { SECRET_KEYS } from "./config.ts";

/**
 * Minimal structured logger with secret redaction (KTD12).
 *
 * Any field whose key matches a known secret name, or whose string value equals
 * a registered secret, is replaced with "[redacted]" before serialization. This
 * is the last line of defense against a raw payload or token reaching a log sink.
 */

type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACTED = "[redacted]";
const SECRET_KEY_SET = new Set<string>(SECRET_KEYS);
const registeredSecretValues = new Set<string>();

/** Register concrete secret values so they are redacted even when nested in payloads. */
export function registerSecretValues(values: Iterable<string>): void {
  for (const v of values) {
    if (v && v.length >= 8) registeredSecretValues.add(v);
  }
}

function redact(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY_SET.has(key)) return REDACTED;
  if (typeof value === "string") {
    return registeredSecretValues.has(value) ? REDACTED : value;
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

/** Exposed for tests. */
export const _internal = { redact };
