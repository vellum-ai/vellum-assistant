/**
 * Barrel for the SSE event wire contracts the assistant daemon exposes.
 *
 * One file per event-source domain. Re-export everything publicly so
 * consumers can `import { X } from "@vellumai/assistant-api/sse-events"`
 * without knowing which domain file `X` lives in.
 */

export * from "./sync.js";
