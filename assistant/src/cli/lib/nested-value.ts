/**
 * Thin re-export of the nested-value helpers from `config/loader.ts`.
 *
 * The `cli/no-daemon-internals` ESLint rule forbids `ipc`-tagged CLI
 * commands from importing `../../config/loader.js` directly (it pulls in
 * daemon-only globals like the config cache and file watcher). These two
 * functions are pure and dependency-free, so we re-export them through the
 * cli/lib/ helper namespace, which IS on the IPC import allowlist.
 *
 * Helper modules (no `registerCommand` call) are exempt from the rule,
 * so the daemon-internal import below is allowed here.
 */
export { getNestedValue, setNestedValue } from "../../config/loader.js";
