/**
 * Test fixture management for the agent runner.
 *
 * Handles setup and teardown of test fixtures like mock servers.
 * Each fixture returns context variables that are injected into
 * the markdown test case template (e.g., {{SERVER_URL}}).
 */

import { execSync } from "child_process";
import path from "path";

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
  "desktop-app": createDesktopAppFixture,
};

// ── Fixture Implementations ─────────────────────────────────────────

async function createDesktopAppFixture(): Promise<FixtureContext> {
  const appDir = path.resolve(__dirname, "../../clients/macos/dist");
  const appDisplayName = process.env.APP_DISPLAY_NAME ?? "Vellum";
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? "";

  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required for desktop-app fixture");
  }

  return {
    variables: {
      APP_DIR: appDir,
      APP_DISPLAY_NAME: appDisplayName,
      ANTHROPIC_API_KEY: anthropicApiKey,
    },
    teardown: async () => {
      // Kill the app on teardown
      try {
        execSync(
          `osascript -e 'tell application "${appDisplayName}" to quit'`,
          { timeout: 5_000 },
        );
      } catch {
        // App may already be closed
      }
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
