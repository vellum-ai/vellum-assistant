/**
 * Shared types and helpers for OAuth CLI commands.
 *
 * This module provides types used across oauth CLI commands and utility
 * functions consumed by non-oauth commands (e.g. config.ts).
 */

import type { Command } from "commander";

import { writeOutput } from "../../output.js";

// ---------------------------------------------------------------------------
// Platform connection helpers
// ---------------------------------------------------------------------------

/**
 * Verify that the user has connected to the Vellum platform (has stored
 * credentials). Unlike `requirePlatformClient`, this does NOT require a
 * platform assistant ID — it only checks that credentials exist.
 *
 * Writes an error and sets exitCode=1 when the user is not connected.
 *
 * NOTE: This is consumed by config.ts (a local-tagged command) for managed
 * mode validation, so it must remain exported here.
 */
export async function requirePlatformConnection(
  cmd: Command,
): Promise<boolean> {
  const { VellumPlatformClient } = await import("../../../platform/client.js");
  const client = await VellumPlatformClient.create();
  if (!client) {
    writeOutput(cmd, {
      ok: false,
      error:
        "Not connected to Vellum platform. Run `vellum platform connect` to connect first.",
    });
    process.exitCode = 1;
    return false;
  }
  return true;
}
