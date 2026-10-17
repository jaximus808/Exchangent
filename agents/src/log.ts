// Structured, demo-friendly console logs.
// LOG_FORMAT=json prints one JSON object per line; the default is a readable single line:
//   12:01:02  dispatcher   deliver  offer.created  seller:acme -> buyer  session=1a2b3c4d total=$400.00

/** Extra key/value pairs attached to a log line. `undefined` values are omitted from the text format. */
export type LogFields = Record<string, unknown>;

export interface LogRecord {
  ts: string;
  scope: string;
  msg: string;
  [field: string]: unknown;
}

export type LogListener = (record: LogRecord) => void;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const listeners = new Set<LogListener>();

/** Subscribe to every log record (used by tests). Returns an unsubscribe function. */
export function onLog(fn: LogListener): () => boolean {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function money(cents: unknown): string {
  if (cents === null || cents === undefined || Number.isNaN(Number(cents))) return String(cents);
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

export function short(id: unknown): unknown {
  return typeof id === "string" && id.length > 8 ? id.slice(0, 8) : id;
}

function fmtValue(key: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (key.endsWith("_cents") || key === "total" || key === "target" || key === "price") return money(value);
  if (key.endsWith("_id") || key === "session" || key === "event") return short(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function log(scope: string, msg: string, fields: LogFields = {}): void {
  const record: LogRecord = { ts: new Date().toISOString(), scope, msg, ...fields };
  for (const fn of listeners) {
    try { fn(record); } catch { /* listener errors never break logging */ }
  }
  if (process.env.LOG_SILENT === "1") return;
  if (process.env.LOG_FORMAT === "json") {
    console.log(JSON.stringify(record));
    return;
  }
  const time = record.ts.slice(11, 19);
  const parts = Object.entries(fields)
    .map(([k, v]) => {
      const f = fmtValue(k, v);
      return f === undefined ? undefined : `${k}=${f}`;
    })
    .filter(Boolean);
  console.log(`${time}  ${scope.padEnd(18)} ${msg}${parts.length ? "  " + parts.join(" ") : ""}`);
}

export function logger(scope: string): Logger {
  return {
    info: (msg, fields) => log(scope, msg, fields),
    warn: (msg, fields) => log(scope, `WARN ${msg}`, fields),
    error: (msg, fields) => log(scope, `ERROR ${msg}`, fields),
  };
}
