/**
 * @vellumai/ipc-contract — Single source of truth for the Electron bridge
 * IPC surface: payload types, Zod validation schemas, the VellumBridge
 * interface, and channel name constants.
 *
 * This is a package entry point, not an app-code barrel file. The
 * "no barrel files" convention in CONVENTIONS.md targets intra-app
 * subdirectory index files that create circular deps; package entry
 * points are the standard Node/Bun resolution mechanism and are
 * explicitly allowed.
 */
export * from "./types";
export * from "./schemas";
export {
  type LocalUpgradeOptions,
  type LocalWakeOptions,
  type VellumBridge,
} from "./bridge";
export * from "./channels";
