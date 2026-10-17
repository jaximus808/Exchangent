import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Small JSON file store (agents/.state/*.json, gitignored). Writes are atomic and owner-only (0600). */
export class JsonState<T extends object = Record<string, unknown>> {
  file: string;
  data: T;

  // The `{}` default only fits the default T; every caller in this package passes `initial`.
  constructor(file: string, initial: T = {} as T) {
    this.file = file;
    // The file is only ever written by save() below, so it holds a T.
    this.data = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : structuredClone(initial);
    const data = this.data as Record<string, unknown>;
    for (const [k, v] of Object.entries(initial)) if (data[k] === undefined) data[k] = structuredClone(v);
  }

  save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }
}
