/**
 * Test fixture management for the agent runner.
 *
 * Handles setup and teardown of test fixtures like mock servers.
 * Each fixture returns context variables that are injected into
 * the markdown test case template (e.g., {{SERVER_URL}}).
 */

import { createMockSignupServer, type MockSignupServer } from "../tests/fixtures/mock-signup-server";

// ── Types ───────────────────────────────────────────────────────────

export interface FixtureContext {
  /** Template variables to substitute in the markdown (e.g., SERVER_URL) */
  variables: Record<string, string>;
  /** Cleanup function to tear down the fixture */
  teardown: () => Promise<void>;
}

// ── Fixture Registry ────────────────────────────────────────────────

type FixtureFactory = () => Promise<FixtureContext>;

const FIXTURE_REGISTRY: Record<string, FixtureFactory> = {
  "mock-signup-server": createMockSignupFixture,
};

// ── Fixture Implementations ─────────────────────────────────────────

async function createMockSignupFixture(): Promise<FixtureContext> {
  const server: MockSignupServer = createMockSignupServer();
  const { url } = await server.start();

  return {
    variables: {
      SERVER_URL: url,
    },
    teardown: async () => {
      await server.stop();
    },
  };
}

// ── Public API ──────────────────────────────────────────────────────

export async function setupFixture(fixtureName: string): Promise<FixtureContext> {
  const factory = FIXTURE_REGISTRY[fixtureName];
  if (!factory) {
    throw new Error(
      `Unknown fixture: "${fixtureName}". Available fixtures: ${Object.keys(FIXTURE_REGISTRY).join(", ")}`,
    );
  }
  return factory();
}
