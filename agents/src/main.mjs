#!/usr/bin/env node
// Entrypoint: `npm start` (reads agents/.env.local and the backend's demo principals file).
import { loadConfig, loadEnvFile } from "./config.mjs";
import { createRunner } from "./runner.mjs";
import { log } from "./log.mjs";

loadEnvFile();

let runner;
try {
  runner = await createRunner(loadConfig());
  await runner.start();
} catch (err) {
  log("runner", `ERROR ${err.message}`);
  process.exit(1);
}

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    log("runner", `${sig}: stopping (waiting for in-flight turns)`);
    await runner.stop().catch(() => {});
    process.exit(0);
  });
}
