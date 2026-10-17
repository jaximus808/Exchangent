// Structured, demo-friendly console logs.
// LOG_FORMAT=json prints one JSON object per line; the default is a readable single line:
//   12:01:02  dispatcher   deliver  offer.created  seller:acme -> buyer  session=1a2b3c4d total=$400.00

const listeners = new Set();

/** Subscribe to every log record (used by tests). Returns an unsubscribe function. */
export function onLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function money(cents) {
  if (cents === null || cents === undefined || Number.isNaN(Number(cents))) return String(cents);
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

export function short(id) {
  return typeof id === "string" && id.length > 8 ? id.slice(0, 8) : id;
}

function fmtValue(key, value) {
  if (value === undefined) return undefined;
  if (key.endsWith("_cents") || key === "total" || key === "target" || key === "price") return money(value);
  if (key.endsWith("_id") || key === "session" || key === "event") return short(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function log(scope, msg, fields = {}) {
  const record = { ts: new Date().toISOString(), scope, msg, ...fields };
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

export function logger(scope) {
  return {
    info: (msg, fields) => log(scope, msg, fields),
    warn: (msg, fields) => log(scope, `WARN ${msg}`, fields),
    error: (msg, fields) => log(scope, `ERROR ${msg}`, fields),
  };
}
