#!/usr/bin/env node
// `wrangler dev`, shut down properly on Ctrl+C.
//
// THE BUG THIS FIXES lives in wrangler's own launcher. `node_modules/wrangler/
// bin/wrangler.js` is a shim that spawns the real CLI as a child and does:
//
//     process.on("SIGINT", () => wranglerProcess.kill());
//
// On POSIX that is a SIGTERM the CLI handles, so it closes miniflare and workerd
// on the way out. Windows has no SIGTERM: libuv turns `.kill()` into
// `TerminateProcess`, so the shim HARD-KILLS the CLI at the exact moment the
// console's Ctrl+C reaches it — before its own shutdown can run. The `workerd`
// the CLI owned is orphaned, still holding :8787, and Windows will happily let
// the next wrangler bind the same port beside it. That is the hang described in
// CLAUDE.md, and `scripts/free-port.mjs` has been cleaning it up on the way IN
// ever since.
//
// So this launches the CLI DIRECTLY, skipping the shim. Ctrl+C then reaches the
// CLI the same way it does on POSIX — it is in this console's process group —
// and nothing shoots it in the head first. Which is the actual fix: the worker
// closes itself, rather than being killed harder.
//
// Everything else here is the backstop, in escalating order, because a dev
// server that *usually* releases its port is not worth much:
//
//   1. Wait for the CLI to exit on its own. It got the same Ctrl+C we did.
//   2. After GRACE_MS, or on a second Ctrl+C, `taskkill /T /F` its tree —
//      `child.kill()` alone would repeat wrangler's own mistake.
//   3. If the port is STILL held, fall back to `freePort`, which matches this
//      repo's stragglers by command line. Needed when the tree walk has nothing
//      to walk: a process that has already exited has no recorded children.
//
// The CLI path is internal to the wrangler package, so it is checked rather than
// assumed — an upgrade that moves it falls back to the shim, which works and is
// merely the behaviour we had before.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { freePort, killTree, listenerPids } from "./free-port.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(REPO_ROOT, "node_modules", "wrangler");

/** How long the CLI gets to close itself before we stop being polite. */
const GRACE_MS = 8000;

const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 8787;

const cli = path.join(WRANGLER, "wrangler-dist", "cli.js");
const shim = path.join(WRANGLER, "bin", "wrangler.js");
const entry = existsSync(cli) ? cli : shim;
if (entry === shim) {
  console.warn(
    "dev-api: wrangler-dist/cli.js is gone, falling back to bin/wrangler.js — " +
      "Ctrl+C may orphan workerd again (see this file's header).",
  );
}

// `--no-warnings` and the ipc channel are what the shim passes; matched so the
// CLI is launched exactly as it expects to be, minus the SIGINT handler that
// was killing it.
const child = spawn(process.execPath, ["--no-warnings", entry, "dev", ...args], {
  stdio: ["inherit", "inherit", "inherit", "ipc"],
});

// The signal handlers below cover Ctrl+C. They cover nothing at all when this
// process is killed outright — a closed VS Code terminal tab, Task Manager,
// `taskkill /F` — and on Windows that leaves workerd running, because killing a
// parent does not kill its children. `dev-watchdog.mjs` is the answer to that
// case: detached, so it survives what it is watching for.
const watchdog = spawn(
  process.execPath,
  [path.join(REPO_ROOT, "scripts", "dev-watchdog.mjs"), String(process.pid), String(port)],
  { detached: true, stdio: "ignore", windowsHide: true },
);
watchdog.unref();

let escalation;
let stopping = false;

/** Last resort, and only reached if the CLI did not close its own port. */
function sweep() {
  if (listenerPids(port).length === 0) return;
  const { remaining } = freePort(port);
  if (remaining.length > 0) {
    console.error(
      `dev-api: port ${port} is STILL held by pid(s) ${remaining.join(", ")}. ` +
        `Kill them by hand — the next dev server would bind alongside them and hang.`,
    );
  }
}

function stop() {
  // A second Ctrl+C means "I meant it": skip the grace period.
  if (stopping) {
    clearTimeout(escalation);
    killTree(child.pid);
    return;
  }
  stopping = true;
  escalation = setTimeout(() => killTree(child.pid), GRACE_MS);
  escalation.unref();
}

// SIGBREAK is Ctrl+Break, and SIGHUP is what a closing terminal window sends;
// both are ordinary ways to stop a dev server and neither should leak a port.
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
  process.on(signal, stop);
}

child.on("exit", (code, signal) => {
  clearTimeout(escalation);
  sweep();
  process.exit(code ?? (signal ? 1 : 0));
});

child.on("error", (err) => {
  console.error(`dev-api: could not start wrangler — ${err.message}`);
  sweep();
  process.exit(1);
});
