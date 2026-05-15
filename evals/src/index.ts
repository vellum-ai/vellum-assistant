/**
 * @vellumai/evals — Vellum Personal-Intelligence Benchmark harness.
 *
 * Public module API. The CLI entry is in `./cli.ts`.
 */
export type {
  AgentAdapter,
  AgentEvent,
  AgentMessage,
  RunningAgent,
} from "./lib/adapter";

export { VellumAdapter } from "./lib/adapters/vellum";

export {
  type Profile,
  type ProfileManifest,
  ProfileManifestSchema,
  loadProfile,
} from "./lib/profile";

export { type TestDef, loadTestDef } from "./lib/test-def";
