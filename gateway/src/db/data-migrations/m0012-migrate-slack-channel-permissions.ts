/**
 * One-time migration: lift Slack-skill channel permission profiles into the
 * gateway `channel_permission_overrides` matrix.
 *
 * Source: `skills.entries.slack.config.channelPermissions` in the assistant
 * config file — a `Record<channelId, ChannelPermissionProfile>` where the
 * profile carries `{ label?, allowedToolCategories?, blockedTools?,
 * trustLevel? }`.
 *
 * Mapping: a profile with `trustLevel: "restricted"` becomes channel-scoped
 * Strict cells (`threshold: "none"`) for the non-guardian contact-types.
 * Per-tool fields (`allowedToolCategories` / `blockedTools`) have no
 * representation in the matrix — per-tool carve-outs are explicitly out of
 * scope for the matrix — so they stay in the skill config, where the
 * legacy deterministic channel gate keeps enforcing them.
 *
 * The skill config is left untouched: it remains the live source for the
 * legacy per-tool gate (blockedTools / allowedToolCategories), which the
 * matrix intentionally does not represent.
 *
 * Idempotent: seeds via ON CONFLICT DO NOTHING, so guardian-configured
 * cells are never overwritten. Safe to re-run.
 */

import { readConfigFile } from "../../config-file-utils.js";
import { getLogger } from "../../logger.js";
import { ChannelPermissionStore } from "../channel-permission-store.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0012-migrate-slack-channel-permissions");

/** Non-guardian contact-types that receive the migrated Strict cells. */
const RESTRICTED_CONTACT_TYPES = [
  "trusted_contact",
  "unverified_contact",
  "unknown",
] as const;

function extractChannelPermissions(
  config: Record<string, unknown>,
): Record<string, unknown> | null {
  const skills = config.skills;
  if (!skills || typeof skills !== "object") {
    return null;
  }
  const entries = (skills as Record<string, unknown>).entries;
  if (!entries || typeof entries !== "object") {
    return null;
  }
  const slack = (entries as Record<string, unknown>).slack;
  if (!slack || typeof slack !== "object") {
    return null;
  }
  const slackConfig = (slack as Record<string, unknown>).config;
  if (!slackConfig || typeof slackConfig !== "object") {
    return null;
  }
  const channelPermissions = (slackConfig as Record<string, unknown>)
    .channelPermissions;
  if (
    !channelPermissions ||
    typeof channelPermissions !== "object" ||
    Array.isArray(channelPermissions)
  ) {
    return null;
  }
  return channelPermissions as Record<string, unknown>;
}

export function up(): MigrationResult {
  // A missing config file reads as `{ ok: true, data: {} }` — a fresh
  // install with genuinely nothing to migrate. A malformed/unreadable file
  // (mid-write crash, transient permission error) is a different state:
  // skip so the ledger retries on the next startup instead of permanently
  // checkpointing the migration against a config it never read.
  const configResult = readConfigFile();
  if (!configResult.ok) {
    log.warn(
      { detail: configResult.detail },
      "Assistant config unreadable; retrying migration on next startup",
    );
    return "skip";
  }

  const channelPermissions = extractChannelPermissions(configResult.data);
  if (!channelPermissions) {
    log.info("No Slack channelPermissions config found; nothing to migrate");
    return "done";
  }

  const store = new ChannelPermissionStore();
  let migrated = 0;
  let skipped = 0;

  for (const [channelId, rawProfile] of Object.entries(channelPermissions)) {
    if (!channelId || !rawProfile || typeof rawProfile !== "object") {
      skipped += 1;
      continue;
    }
    const trustLevel = (rawProfile as Record<string, unknown>).trustLevel;
    if (trustLevel !== "restricted") {
      // "standard" (or absent) carries no threshold semantics; per-tool
      // fields stay with the legacy gate in the skill config.
      skipped += 1;
      continue;
    }

    for (const contactType of RESTRICTED_CONTACT_TYPES) {
      store.seedCell({
        selector: {
          scope: "channel",
          adapter: "slack",
          channelExternalId: channelId,
        },
        contactType,
        threshold: "none",
        note: "Migrated from Slack skill channelPermissions (trustLevel: restricted)",
      });
    }
    migrated += 1;
  }

  log.info(
    { migrated, skipped },
    "Slack channel permission profiles migrated into channel_permission_overrides",
  );
  return "done";
}

export function down(): MigrationResult {
  // The migrated cells carry a provenance note but removing them could also
  // remove guardian edits made after migration; leave them in place.
  return "done";
}
