#!/usr/bin/env node
// Clear a wedged dev port before something tries to bind it.
//
// WHY THIS EXISTS: `wrangler dev` did not die cleanly on Windows. Ctrl+C reached
// the npm shim but not the `workerd` grandchildren, which kept holding the
// socket -- and Windows lets the NEXT wrangler bind the same port anyway.
// Connections then get split between a live worker and a dead one: the socket
// accepts, nothing ever answers, and the SPA sits on pending requests with
// nothing in the network tab or console. "The API hangs" is always this.
//
// Killing the listener alone is not enough: the orphaned wrangler parent
// respawns workerd within seconds. So on Windows we also kill this repo's
// wrangler/workerd process trees, matched by the repo path in their command
// line (never another project's dev server).
//
// `scripts/dev-api.mjs` now shuts the worker down properly on the way OUT, so
// this should have nothing to do. It is kept, and still wired up as
// `predev:api`, because it is the only thing that helps after a hard kill --
// Task Manager, a closed terminal window, a machine that crashed -- where no
// handler of ours ever ran. Also runnable directly: `npm run dev:api:stop`.
//
// The functions are exported because `dev-api.mjs` uses them as its LAST resort:
// one implementation of "what is still holding this port and how do I get rid of
// it", not two that can disagree.

import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WINDOWS = process.platform === "win32";

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
export function listenerPids(port) {
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
export function repoWranglerPids() {
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

/** Kill one process AND its children. `child.kill()` on Windows kills a single
 *  process, which is the whole reason workerd gets orphaned in the first place. */
export function killTree(pid) {
  if (pid == null) return;
  const id = String(pid);
  if (id === "0" || id === String(process.pid)) return;
  // /T takes the children with it; without /F wrangler's node parent lingers.
  if (IS_WINDOWS) run("taskkill", ["/PID", id, "/T", "/F"]);
  else {
    try {
      process.kill(Number(id), "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Make `port` bindable, and report honestly if it could not be.
 *
 * The socket is released when the process dies, but taskkill returns before the
 * kernel has caught up — so this verifies rather than assumes. A stale listener
 * that survives is exactly the bug it exists to prevent.
 */
export function freePort(port) {
  const victims = new Set([...listenerPids(port), ...repoWranglerPids()]);
  for (const pid of victims) killTree(pid);

  const deadline = Date.now() + 5000;
  let remaining = listenerPids(port);
  while (remaining.length > 0 && Date.now() < deadline) {
    remaining = listenerPids(port);
  }
  return { killed: victims.size, remaining };
}

// ---- CLI --------------------------------------------------------------------
// Only when run as `node scripts/free-port.mjs <port>`, so importing this from
// dev-api.mjs does not kill anything on its own.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2]);
  if (!Number.isInteger(port) || port <= 0) {
    console.error("usage: node scripts/free-port.mjs <port>");
    process.exit(1);
  }

  const { killed, remaining } = freePort(port);
  if (remaining.length > 0) {
    console.error(
      `free-port: port ${port} is STILL held by pid(s) ${remaining.join(", ")} — ` +
        `kill them by hand before starting, or the next server will bind alongside them and hang.`,
    );
    process.exit(1);
  }
  if (killed > 0) console.log(`free-port: cleared ${killed} stale process(es) off port ${port}`);
}
