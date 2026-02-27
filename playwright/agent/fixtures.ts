/**
 * Test fixture management for the agent runner.
 *
 * Handles setup and teardown of test fixtures. Each fixture performs
 * any required pre-test setup (e.g., verifying app exists, clearing state)
 * and provides a teardown function for cleanup.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";

// ── Types ───────────────────────────────────────────────────────────

export interface FixtureContext {
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
  const appPath = path.join(appDir, `${appDisplayName}.app`);

  // Verify the built macOS app exists
  if (!existsSync(appPath)) {
    throw new Error(`Built macOS app not found at: ${appPath}`);
  }

  // Clear any previous onboarding state
  try {
    execSync("defaults delete com.vellum.vellum-assistant", {
      encoding: "utf-8",
      timeout: 5_000,
    });
  } catch {
    // Domain may not exist yet on a fresh runner — that's fine
  }

  return {
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
