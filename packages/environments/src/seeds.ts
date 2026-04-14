import type { EnvironmentDefinition } from "./types.js";

/**
 * Built-in environment definitions. Mirrors Swift's
 * `clients/macos/vellum-assistant/App/VellumEnvironment.swift` enum. Five
 * entries that ship with the binary and are always available.
 *
 * Custom environments via a user config file are a future phase — see the
 * "Coexisting environments" design doc. Until then, a call site that needs a
 * new environment must add it here and rebuild.
 */
export const SEEDS: Record<string, EnvironmentDefinition> = {
  production: {
    name: "production",
    platformUrl: "https://platform.vellum.ai",
  },
  staging: {
    name: "staging",
    platformUrl: "https://staging-platform.vellum.ai",
  },
  test: {
    name: "test",
    // Non-functional URL — used only by unit tests for URL resolution, never
    // hit in production.
    platformUrl: "https://test-platform.vellum.ai",
  },
  dev: {
    name: "dev",
    platformUrl: "https://dev-platform.vellum.ai",
  },
  local: {
    name: "local",
    platformUrl: "http://localhost:8000",
    // assistantPlatformUrl: "http://host.docker.internal:8000",
    // ^ uncomment this once dockerized hatch path is live.
    // The assistant runs in a different network namespace than the host.
  },
};
