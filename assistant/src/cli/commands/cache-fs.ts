/**
 * Thin re-export of `node:fs` functions used by the cache CLI command.
 *
 * This indirection exists solely so tests can `mock.module("./cache-fs.js")`
 * without mocking all of `node:fs` — which causes bun's test runner to hang
 * on exit.
 */
export { existsSync, readFileSync } from "node:fs";
