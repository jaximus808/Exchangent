#!/usr/bin/env node
// Entrypoint: `npm start` (reads agents/.env.local and the backend's demo principals file).
import { loadConfig, loadEnvFile } from "./config.ts";
import { createRunner } from "./runner.ts";
import type { Runner } from "./runner.ts";
import { acquireRunnerLock } from "./lock.ts";
import type { RunnerLock } from "./lock.ts";
import { log } from "./log.ts";

loadEnvFile();

let runner: Runner;
let lock: RunnerLock | null = null;
try {
  const config = loadConfig();
  lock = acquireRunnerLock(config.stateDir);
  runner = await createRunner(config);
  await runner.start();
} catch (err) {
  log("runner", `ERROR ${(err as Error).message}`);
  lock?.release();
  process.exit(1);
}

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    log("runner", `${sig}: stopping (waiting for in-flight turns)`);
    await runner.stop().catch(() => {});
    lock?.release();
    process.exit(0);
  });
}
