// One runner per state dir. Two runners on the same Inkbox identities steal each other's tunnels and both
// answer the same events, so a second `npm start` (or `npm run start:sandboxed`) refuses to run.
// The lock file holds a heartbeat: it also works between the host and the sandbox container, where PIDs
// from the other side mean nothing. A lock whose heartbeat is older than STALE_MS is taken over.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 90_000;

interface LockData {
  pid: number;
  host: string;
  started_at: string;
  heartbeat_at: string;
}

export interface RunnerLock {
  file: string;
  release(): void;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function read(file: string): LockData | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as LockData;
  } catch {
    return null;
  }
}

/**
 * Take the runner lock in `stateDir`, or throw if another live runner holds it. A lock is free when its
 * heartbeat is stale, or when it was written on this host by a process that no longer exists.
 */
export function acquireRunnerLock(stateDir: string, { now = () => Date.now(), pid = process.pid, host = hostname(), heartbeatMs = HEARTBEAT_MS } = {}): RunnerLock {
  const file = path.join(stateDir, "runner.lock");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const held = existsSync(file) ? read(file) : null;
  if (held && held.pid !== pid) {
    const fresh = now() - Date.parse(held.heartbeat_at) < STALE_MS;
    const deadHere = held.host === host && !alive(held.pid);
    if (fresh && !deadHere) {
      throw new Error(
        `another runner is already running (pid ${held.pid} on ${held.host}, since ${held.started_at}). ` +
          `Stop it first: two runners on the same Inkbox identities take each other's tunnels. ` +
          `If it is gone, delete ${file}.`,
      );
    }
  }
  const started = new Date(now()).toISOString();
  const write = () => writeFileSync(file, JSON.stringify({ pid, host, started_at: started, heartbeat_at: new Date(now()).toISOString() }) + "\n", { mode: 0o600 });
  write();
  const timer = heartbeatMs > 0 ? setInterval(write, heartbeatMs) : null;
  timer?.unref?.();
  let released = false;
  return {
    file,
    release() {
      if (released) return;
      released = true;
      if (timer) clearInterval(timer);
      if (read(file)?.pid === pid) rmSync(file, { force: true });
    },
  };
}
