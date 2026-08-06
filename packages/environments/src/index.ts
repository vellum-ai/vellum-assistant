/**
 * @vellumai/environments: the single source of truth for how a Vellum install
 * is laid out and which deployment environment it belongs to.
 *
 * Two things live here:
 *
 *   - The known deployment environments (names, platform/web URLs, per-service
 *     port blocks). The Swift client mirrors the same set in
 *     `VellumEnvironment.swift`.
 *   - Install layout: whether a runtime is a repo checkout or an installed
 *     package, and where the `assistant` command it ships lives.
 *
 * Consumed by the CLI, the assistant daemon, and the local-mode host library
 * so each answer is defined exactly once on the TS side.
 *
 * This is the lowest layer of the shared-packages hierarchy and stays a leaf:
 * types, constants, and small helpers over node builtins, with no runtime
 * dependencies of its own. See `__tests__/package-boundary.test.ts`.
 */
export * from "./types.js";
export * from "./seeds.js";
export * from "./install-layout.js";
