// Runs the agent runner as a macOS launchd user agent, so it keeps going headless (no terminal) and restarts
// if it crashes or is killed. A stop is final: the job is unloaded, then SIGTERM lets in-flight turns finish.
//   npm run service start      write the plist, enable the job and start it
//   npm run service stop       stop it and keep it off (also across logins)
//   npm run service restart    stop, then start (picks up new code and agents/.env.local)
//   npm run service status     launchd state, PID and the runner lock heartbeat
//   npm run service logs       follow agents/.state/logs/runner.log
//   npm run service uninstall  stop and remove the plist
// The job runs `npm start`'s entrypoint with BRAIN and SKIP_BACKLOG taken from this shell (default claude / 0),
// under `caffeinate -i` so the Mac doesn't idle-sleep while agents are on. Closing the lid still sleeps it.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LABEL = "com.exchangent.agents";

export interface PlistOptions {
  agentsDir: string;
  node: string;
  path: string;
  home: string;
  logFile: string;
  env: Record<string, string>;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const str = (s: string) => `<string>${xml(s)}</string>`;

/**
 * The launchd job: a shell that keeps the Mac awake (`caffeinate -w` on its own pid) and restarts the runner
 * 15s after any crash or kill. The restart lives in the job because launchd defers its own KeepAlive respawns
 * on battery power. A stop (launchd's SIGTERM to the shell) is forwarded to the runner, which lets in-flight
 * turns finish and exits; the shell then exits 0 and nothing restarts. A clean runner exit also ends the job.
 */
export function servicePlist(o: PlistOptions): string {
  const env = { PATH: o.path, HOME: o.home, LANG: "en_US.UTF-8", ...o.env };
  const node = `'${o.node.replace(/'/g, `'\\''`)}'`;
  const command = [
    "/usr/bin/caffeinate -i -w $$ &",
    "trap 'kill -TERM $child 2>/dev/null; wait $child; exit 0' TERM INT",
    `while :; do ${node} src/main.ts & child=$!; wait $child; code=$?`,
    `[ $code -eq 0 ] && exit 0; echo "service: runner exited ($code), restarting in 15s"; sleep 15; done`,
  ].join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(LABEL)}
  <key>ProgramArguments</key>
  <array>${str("/bin/sh")}${str("-c")}${str(command)}</array>
  <key>WorkingDirectory</key>${str(o.agentsDir)}
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key>${str(v)}`).join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>60</integer>
  <key>ProcessType</key>${str("Interactive")}
  <key>StandardOutPath</key>${str(o.logFile)}
  <key>StandardErrorPath</key>${str(o.logFile)}
</dict>
</plist>
`;
}

const agentsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plistFile = path.join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const logFile = path.join(agentsDir, ".state", "logs", "runner.log");
const lockFile = path.join(agentsDir, ".state", "runner.lock");
const domain = `gui/${userInfo().uid}`;
const target = `${domain}/${LABEL}`;

function launchctl(...args: string[]) {
  return spawnSync("launchctl", args, { encoding: "utf8" });
}
/** launchd's view of the job: null when it isn't loaded. */
function job(): { state: string; pid: number | null } | null {
  const r = launchctl("print", target);
  if (r.status !== 0) return null;
  const pid = /^\s*pid = (\d+)/m.exec(r.stdout)?.[1];
  return { state: /^\s*state = (\S+)/m.exec(r.stdout)?.[1] ?? "unknown", pid: pid ? Number(pid) : null };
}
function lock(): { pid: number; heartbeat_at: string } | null {
  try { return JSON.parse(readFileSync(lockFile, "utf8")) as { pid: number; heartbeat_at: string }; } catch { return null; }
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function which(bin: string) {
  return execFileSync("/usr/bin/which", [bin], { encoding: "utf8" }).trim();
}

function start() {
  const running = job();
  if (running?.pid) return console.log(`already running (pid ${running.pid}). Use restart to reload it.`);
  // A runner started by hand in a terminal holds the lock; the job would only crash-loop against it.
  const held = lock();
  if (held && alive(held.pid)) {
    console.error(`another runner is running (pid ${held.pid}), probably \`npm start\` in a terminal. Stop it first (Ctrl+C).`);
    process.exit(1);
  }
  // The stable shim (e.g. /opt/homebrew/bin/node), not the versioned binary a Homebrew upgrade removes.
  const node = which("node") || process.execPath;
  const dirs = [path.dirname(node), path.dirname(which("claude")), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(plistFile), { recursive: true });
  writeFileSync(plistFile, servicePlist({
    agentsDir, node, path: [...new Set(dirs)].join(":"), home: homedir(), logFile,
    env: { BRAIN: process.env.BRAIN ?? "claude", SKIP_BACKLOG: process.env.SKIP_BACKLOG ?? "0" },
  }), { mode: 0o644 });
  launchctl("enable", target);
  if (running) launchctl("bootout", target);
  const r = launchctl("bootstrap", domain, plistFile);
  if (r.status !== 0) {
    console.error(`launchctl bootstrap failed: ${(r.stderr || r.stdout).trim()}`);
    process.exit(1);
  }
  // RunAtLoad alone can leave the first spawn pending ("speculative"); kickstart launches it now.
  launchctl("kickstart", target);
  console.log(`started ${LABEL} (BRAIN=${process.env.BRAIN ?? "claude"} SKIP_BACKLOG=${process.env.SKIP_BACKLOG ?? "0"})`);
  console.log(`logs: npm run service logs   (${logFile})`);
}

function stop() {
  // Disabled jobs stay off at the next login too; start enables it again.
  launchctl("disable", target);
  if (!job()) return console.log("not running");
  console.log("stopping (in-flight turns finish first, up to 60s)...");
  launchctl("bootout", target);
  console.log("stopped");
}

function status() {
  const j = job();
  console.log(j ? `${LABEL}: ${j.state}${j.pid ? ` (pid ${j.pid})` : ""}` : `${LABEL}: not loaded`);
  const held = lock();
  if (held) {
    const age = Math.round((Date.now() - Date.parse(held.heartbeat_at)) / 1000);
    console.log(`runner lock: pid ${held.pid}${alive(held.pid) ? "" : " (not running)"}, heartbeat ${age}s ago`);
  }
  console.log(`log: ${logFile}`);
}

function logs() {
  if (!existsSync(logFile)) return console.log(`no log yet at ${logFile}`);
  spawnSync("tail", ["-n", "50", "-f", logFile], { stdio: "inherit" });
}

function uninstall() {
  stop();
  rmSync(plistFile, { force: true });
  console.log(`removed ${plistFile}`);
}

const commands: Record<string, () => void> = { start, stop, restart: () => { stop(); start(); }, status, logs, uninstall };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] ?? "status";
  if (process.platform !== "darwin") {
    console.error("the service uses launchd (macOS). Elsewhere run `npm start` under your own supervisor.");
    process.exit(1);
  }
  if (!commands[cmd]) {
    console.error(`usage: npm run service ${Object.keys(commands).join(" | ")}`);
    process.exit(1);
  }
  commands[cmd]();
}
