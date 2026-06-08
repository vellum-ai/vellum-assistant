/**
 * @vellumai/environments — the single source of truth for Vellum's known
 * deployment environments (names, platform/web URLs, per-service port
 * blocks). Consumed by the CLI, the assistant daemon, and the local-mode
 * host library so the environment list is defined exactly once on the TS
 * side. The Swift client mirrors the same set in `VellumEnvironment.swift`.
 *
 * Intentionally free of runtime dependencies: pure types and constants only.
 */
export * from "./types.js";
export * from "./seeds.js";
