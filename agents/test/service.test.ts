// scripts/service.ts: the launchd job that runs the agent runner headless.
import test from "node:test";
import assert from "node:assert/strict";
import { LABEL, servicePlist } from "../scripts/service.ts";

const plist = servicePlist({
  agentsDir: "/repo/agents", node: "/opt/homebrew/bin/node", path: "/opt/homebrew/bin:/usr/bin",
  home: "/Users/me", logFile: "/repo/agents/.state/logs/runner.log", env: { BRAIN: "claude", SKIP_BACKLOG: "0" },
});

test("service plist runs the runner from agents/ under caffeinate, restarting it after a crash", () => {
  assert.match(plist, new RegExp(`<key>Label</key><string>${LABEL}</string>`));
  assert.match(plist, /<key>WorkingDirectory<\/key><string>\/repo\/agents<\/string>/);
  assert.match(plist, /\/usr\/bin\/caffeinate -i -w \$\$ &amp;/);
  assert.match(plist, /while :; do '\/opt\/homebrew\/bin\/node' src\/main.ts &amp; child=\$!; wait \$child; code=\$\?/);
  assert.match(plist, /\[ \$code -eq 0 \] &amp;&amp; exit 0;/);
  // A stop reaches the runner as SIGTERM, and the job then exits cleanly.
  assert.match(plist, /trap 'kill -TERM \$child 2&gt;\/dev\/null; wait \$child; exit 0' TERM INT/);
});

test("service plist keeps the runner alive and logs to agents/.state", () => {
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>StandardOutPath<\/key><string>\/repo\/agents\/.state\/logs\/runner.log<\/string>/);
  assert.match(plist, /<key>BRAIN<\/key><string>claude<\/string><key>SKIP_BACKLOG<\/key><string>0<\/string>/);
  assert.match(plist, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
});

test("service plist escapes XML in paths", () => {
  const odd = servicePlist({ agentsDir: "/a&b/<agents>", node: "/n", path: "/p", home: "/h", logFile: "/l", env: {} });
  assert.match(odd, /<string>\/a&amp;b\/&lt;agents&gt;<\/string>/);
  assert.doesNotMatch(odd, /\/a&b/);
});
