#!/usr/bin/env node
// The half of the shutdown that cannot be signalled.
//
// `dev-api.mjs` handles SIGINT/SIGBREAK/SIGHUP, which covers Ctrl+C in a real
// console. It cannot cover being killed OUTRIGHT — closing a VS Code terminal
// tab, Task Manager, `taskkill /F`, a crash — because in those cases no handler
// runs anywhere, and on Windows killing a parent does not kill its children. The
// `workerd` holding :8787 simply carries on, and the next dev server binds the
// port beside it and hangs.
//
// So this is a separate, detached process whose only job is to outlive that: it
// watches the supervisor's pid and, the moment it is gone, releases the port.
// Detached on purpose — a child of the supervisor would be killed by the very
// thing it exists to survive.
//
// It can only ever kill what `freePort` matches: a listener on this repo's dev
// port, and this repo's own wrangler/workerd processes. It never kills by the
// pid it was handed, because pids are reused on Windows and this outlives the
// process it is named after.
//
// Started by `dev-api.mjs`; not meant to be run by hand.

import { freePort, listenerPids } from "./free-port.mjs";

const supervisorPid = Number(process.argv[2]);
const port = Number(process.argv[3]);

if (!Number.isInteger(supervisorPid) || !Number.isInteger(port)) {
  process.exit(1);
}

/** `signal 0` is the standard "does this pid exist" probe — it delivers nothing
 *  and throws ESRCH when the process is gone. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// If the supervisor is already gone, we were started into a race we lost.
// Cleaning up is still the right thing to do.
const timer = setInterval(() => {
  if (alive(supervisorPid)) return;
  clearInterval(timer);
  // Usually a no-op: the supervisor normally exits only AFTER its child has, so
  // there is nothing left to find. This matters on the path where it never got
  // to run its own shutdown at all.
  if (listenerPids(port).length > 0) freePort(port);
  process.exit(0);
}, 1000);
