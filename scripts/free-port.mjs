#!/usr/bin/env node
// Clear a wedged dev port before something tries to bind it.
//
// WHY THIS EXISTS: `wrangler dev` does not die cleanly on Windows. Ctrl+C
// reaches the npm shim but not the `workerd` grandchildren, which keep holding
// the socket -- and Windows lets the NEXT wrangler bind the same port anyway.
// Connections then get split between a live worker and a dead one: the socket
// accepts, nothing ever answers, and the SPA sits on pending requests with
// nothing in the network tab or console. "The API hangs" is always this.
//
// Killing the listener alone is not enough: the orphaned wrangler parent
// respawns workerd within seconds. So on Windows we also kill this repo's
// wrangler/workerd process trees, matched by the repo path in their command
// line (never another project's dev server).
//
// Wired up as `predev:api`, so a wedged leftover is cleared on the way in
// rather than colliding. Also runnable directly: `npm run dev:api:stop`.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WINDOWS = process.platform === "win32";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  console.error("usage: node scripts/free-port.mjs <port>");
  process.exit(1);
}

/** Run a command for its stdout. "Nothing matched" is an exit code for most of
 *  these tools, not an error, so a non-zero exit is not worth reporting. */
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/** PIDs listening on `port`, IPv4 and IPv6 alike. */
function listenerPids() {
  if (IS_WINDOWS) {
    const pids = new Set();
    for (const line of run("netstat", ["-ano", "-p", "TCP"]).split(/\r?\n/)) {
      // "  TCP    127.0.0.1:8787    0.0.0.0:0    LISTENING    39920"
      const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
      if (m && Number(m[2]) === port) pids.add(m[3]);
    }
    return [...pids];
  }
  return run("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]).split(/\s+/).filter(Boolean);
}

/** This repo's wrangler/workerd processes — the ones that respawn a killed
 *  worker. Windows only; on POSIX Ctrl+C already tears the tree down. */
function repoWranglerPids() {
  if (!IS_WINDOWS) return [];
  const script =
    `Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='workerd.exe'" | ` +
    `Where-Object { $_.CommandLine -like '*${REPO_ROOT}*' -and ` +
    `($_.Name -eq 'workerd.exe' -or $_.CommandLine -like '*wrangler*') } | ` +
    `Select-Object -ExpandProperty ProcessId`;
  return run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script])
    .split(/\s+/)
    .filter(Boolean);
}

function kill(pid) {
  if (pid === "0" || pid === String(process.pid)) return;
  // /T takes the children with it; without /F wrangler's node parent lingers.
  if (IS_WINDOWS) run("taskkill", ["/PID", pid, "/T", "/F"]);
  else run("kill", ["-9", pid]);
}

const victims = new Set([...listenerPids(), ...repoWranglerPids()]);
if (victims.size === 0) process.exit(0);

for (const pid of victims) kill(pid);

// The socket is released when the process dies, but taskkill returns before the
// kernel has caught up — verify rather than assume, since a stale listener that
// survives this is exactly the bug we are here to prevent.
const deadline = Date.now() + 5000;
let remaining = listenerPids();
while (remaining.length > 0 && Date.now() < deadline) {
  remaining = listenerPids();
}

if (remaining.length > 0) {
  console.error(
    `free-port: port ${port} is STILL held by pid(s) ${remaining.join(", ")} — ` +
      `kill them by hand before starting, or the next server will bind alongside them and hang.`,
  );
  process.exit(1);
}
console.log(`free-port: cleared ${victims.size} stale process(es) off port ${port}`);
