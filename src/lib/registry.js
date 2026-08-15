/**
 * The plugin registry — the one seam through which enterprise code attaches.
 *
 * Core (`src/`, MIT) never imports from `ee/`. Instead, an installed
 * `fleetsmith-ee` package is loaded fail-soft by the CLI (see the loader in
 * `cli.js`) and handed this module's exports, through which it registers
 * memory backends, CLI verbs, and daemon hooks. `rm -rf ee/` must leave core
 * behaving exactly as before: it never queries whether ee is installed, it
 * only exposes a place ee can write to.
 *
 * The file backend registers through this same registry (see the bottom of
 * `memory/file.js`), so the seam is exercised on every OSS invocation, not
 * only enterprise ones — a seam nothing ever calls is the first one that
 * silently breaks.
 *
 * Duplicate registration under one name throws immediately rather than
 * silently overwriting: two backends or commands racing for the same name is
 * a packaging bug, and failing fast at load time is cheaper than debugging
 * which one won at call time.
 */

const backends = new Map();
const commands = new Map();
const HOOK_EVENTS = ['run_start', 'run_end'];
const hooks = Object.fromEntries(HOOK_EVENTS.map((e) => [e, []]));

/** `factory(config) -> backend`, where backend implements the five-verb port shape (`src/memory/port.js`). */
export function registerMemoryBackend(name, factory) {
  if (backends.has(name)) throw new Error(`memory backend "${name}" is already registered`);
  backends.set(name, factory);
}

/** The registered factory for `name`, or `undefined`. Registering does not select a backend — callers choose by name. */
export function getMemoryBackend(name) {
  return backends.get(name);
}

/** `handler(argv) -> Promise<exitCode>`. `argv` is the raw args after the command name, unparsed. */
export function registerCliCommand(name, handler) {
  if (commands.has(name)) throw new Error(`CLI command "${name}" is already registered`);
  commands.set(name, handler);
}

/** The registered handler for `name`, or `undefined`. */
export function getCliCommand(name) {
  return commands.get(name);
}

/**
 * `fn(...)` for a reserved lifecycle event. Hooks are advisory: a run must
 * complete identically whether or not any are registered, so `runDaemonHooks`
 * (not this function) is what enforces fail-soft behavior at call time.
 */
export function registerDaemonHook(event, fn) {
  if (!HOOK_EVENTS.includes(event)) {
    throw new Error(`unknown daemon hook event "${event}" (expected: ${HOOK_EVENTS.join(', ')})`);
  }
  hooks[event].push(fn);
}

/**
 * Fire every hook registered for `event`. Fire-and-forget by contract: a
 * throwing hook is logged and skipped, never propagated — a broken enterprise
 * hook must not fail the run telemetry it was only ever advisory to.
 */
export async function runDaemonHooks(event, ...args) {
  for (const fn of hooks[event] ?? []) {
    try {
      await fn(...args);
    } catch (e) {
      console.error(`daemon hook "${event}" failed: ${e.message}`);
    }
  }
}

/** Names only — for `fleetsmith --version` display and tests. Never exposes factories or handlers. */
export function listRegistered() {
  return {
    backends: [...backends.keys()],
    commands: [...commands.keys()],
    hooks: Object.fromEntries(Object.entries(hooks).map(([event, fns]) => [event, fns.length])),
  };
}

/**
 * Test-only. The registry is a process-wide singleton so that ee code and
 * core share one instance without passing it around; tests that register
 * fixtures need a way back to empty rather than leaking into later tests.
 */
export function _resetForTests() {
  backends.clear();
  commands.clear();
  for (const event of HOOK_EVENTS) hooks[event] = [];
}
