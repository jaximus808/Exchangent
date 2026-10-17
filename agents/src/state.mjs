import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Small JSON file store (agents/.state/*.json, gitignored). Writes are atomic and owner-only (0600). */
export class JsonState {
  constructor(file, initial = {}) {
    this.file = file;
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : structuredClone(initial);
    for (const [k, v] of Object.entries(initial)) if (this.data[k] === undefined) this.data[k] = structuredClone(v);
  }

  save() {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }
}
