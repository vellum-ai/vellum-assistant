import { eq, sql } from "drizzle-orm";
import { type GatewayDb, getGatewayDb } from "./connection.js";
import { channelAdmissionPolicy, conversationAdmissionOverride } from "./schema.js";
import { type ChannelId, isChannelId } from "../channels/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-channel inbound admission policy — ordered from most-restrictive
 * (`no_one`, hard kill switch) to most-permissive (`strangers`, admits any
 * sender). See plan section 2.3.
 */
export type AdmissionPolicy =
  | "no_one"
  | "guardian_only"
  | "trusted_contacts"
  | "any_contact"
  | "strangers";

export const ADMISSION_POLICY_VALUES: ReadonlyArray<AdmissionPolicy> = [
  "no_one",
  "guardian_only",
  "trusted_contacts",
  "any_contact",
  "strangers",
];

export const VALID_ADMISSION_POLICY_VALUES: ReadonlySet<string> = new Set(
  ADMISSION_POLICY_VALUES,
);

/**
 * Read-side default applied when a channel has no row in the DB. Matches
 * today's effective semantics: guardian + active contacts admitted,
 * strangers denied. See plan section 2.2.
 */
export const ADMISSION_POLICY_DEFAULT: AdmissionPolicy = "trusted_contacts";

/**
 * Minimum trust rank required for each policy. Higher rank = more trusted.
 * `no_one` is 5 — above the maximum guardian rank (4) — so no class is ever
 * admitted. See plan section 2.4 for the rank table (guardian=4,
 * trusted_contact=3, unverified_contact=2, unknown=1; blocked/revoked=0).
 */
export const ADMISSION_FLOOR: Record<AdmissionPolicy, number> = {
  no_one: 5,
  guardian_only: 4,
  trusted_contacts: 3,
  any_contact: 2,
  strangers: 1,
};

export interface AdmissionPolicyRow {
  channelType: ChannelId;
  policy: AdmissionPolicy;
  note: string | null;
  updatedAt: number;
}

export interface ConversationAdmissionOverrideRow {
  conversationId: string;
  channelType: string | null;
  override: AdmissionPolicy;
  updatedAt: number;
}

/**
 * Read-side view returned by the conversation override endpoints.
 * `typeFloor` is merged from the channel-type policy (or the default).
 */
export interface ConversationOverrideView {
  conversationId: string;
  channelType: string | null;
  override: AdmissionPolicy | null;
  typeFloor: AdmissionPolicy;
  updatedAt: number | null;
}

/**
 * Internal channels that must not receive user-configurable overrides (§8.1).
 * Matches the client-side list in `apps/web/src/lib/channel-admission-policy/types.ts`.
 */
export const EXEMPT_CHANNEL_TYPES = new Set<string>(["vellum", "platform", "a2a"]);

export function isExemptChannelType(channelType: string): boolean {
  return EXEMPT_CHANNEL_TYPES.has(channelType);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isAdmissionPolicy(value: unknown): value is AdmissionPolicy {
  return typeof value === "string" && VALID_ADMISSION_POLICY_VALUES.has(value);
}

function coercePolicy(value: string): AdmissionPolicy {
  // Belt-and-suspenders: the schema accepts any text, but writes are
  // app-validated. Fall back to the default if a non-canonical value ever
  // appears (e.g. legacy row from a future write that was rolled back).
  return isAdmissionPolicy(value) ? value : ADMISSION_POLICY_DEFAULT;
}

function coerceChannelType(value: string): ChannelId | null {
  return isChannelId(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class AdmissionPolicyStore {
  private injectedDb?: GatewayDb;

  constructor(db?: GatewayDb) {
    this.injectedDb = db;
  }

  private get db(): GatewayDb {
    return this.injectedDb ?? getGatewayDb();
  }

  /**
   * Resolve the policy for a channel. Returns `ADMISSION_POLICY_DEFAULT`
   * when the row is missing — same fallback pattern as
   * `auto_approve_thresholds` (see `readInteractiveThreshold` in
   * `gateway/src/http/routes/trust-rules.ts`).
   */
  get(channelType: ChannelId): AdmissionPolicy {
    const row = this.db
      .select()
      .from(channelAdmissionPolicy)
      .where(eq(channelAdmissionPolicy.channelType, channelType))
      .get();
    if (!row) return ADMISSION_POLICY_DEFAULT;
    return coercePolicy(row.policy);
  }

  /**
   * List every persisted policy row. Channels with no row do **not** appear
   * here — the HTTP layer merges the default in for absent channels so the
   * client sees a complete view.
   */
  list(): AdmissionPolicyRow[] {
    const rows = this.db.select().from(channelAdmissionPolicy).all();
    const out: AdmissionPolicyRow[] = [];
    for (const row of rows) {
      const channelType = coerceChannelType(row.channelType);
      if (!channelType) continue;
      out.push({
        channelType,
        policy: coercePolicy(row.policy),
        note: row.note,
        updatedAt: row.updatedAt,
      });
    }
    return out;
  }

  /**
   * Upsert the policy for a channel. Stamps `updatedAt` to the current
   * epoch ms. Cache invalidation is the caller's responsibility (HTTP layer
   * calls `invalidateAdmissionPolicyCache()` after mutations) so this store
   * stays a pure data layer, matching how `TrustRuleStore` operates with
   * `invalidateTrustRuleCache()`.
   */
  set(
    channelType: ChannelId,
    policy: AdmissionPolicy,
    note?: string | null,
  ): AdmissionPolicyRow {
    const now = Date.now();
    const noteValue = note ?? null;

    this.db.run(sql`
      INSERT INTO channel_admission_policy (channel_type, policy, note, updated_at)
      VALUES (${channelType}, ${policy}, ${noteValue}, ${now})
      ON CONFLICT (channel_type) DO UPDATE SET
        policy = excluded.policy,
        note = excluded.note,
        updated_at = excluded.updated_at
    `);

    return {
      channelType,
      policy,
      note: noteValue,
      updatedAt: now,
    };
  }

  /**
   * Hard-delete the row, resetting the channel to the read-side default.
   * Returns true if a row was deleted, false if nothing was there. The
   * existence check is a separate SELECT because drizzle's bun-sqlite
   * `.run()` returns void — there's no rowcount surfaced through the
   * typed API.
   */
  remove(channelType: ChannelId): boolean {
    const existing = this.db
      .select()
      .from(channelAdmissionPolicy)
      .where(eq(channelAdmissionPolicy.channelType, channelType))
      .get();
    if (!existing) return false;

    this.db
      .delete(channelAdmissionPolicy)
      .where(eq(channelAdmissionPolicy.channelType, channelType))
      .run();
    return true;
  }

  // -------------------------------------------------------------------------
  // Conversation-level override API (§8.3)
  // -------------------------------------------------------------------------

  /**
   * Read the override view for a single conversation. Always returns a view:
   * `override` is null when no row exists (meaning "inherit type floor").
   * `typeFloor` is merged from the channel-type policy row or the default.
   */
  getConversationOverride(conversationId: string): ConversationOverrideView {
    const row = this.db
      .select()
      .from(conversationAdmissionOverride)
      .where(eq(conversationAdmissionOverride.conversationId, conversationId))
      .get();

    // Resolve the type floor from the stored channelType (if any).
    const channelType = row?.channelType ?? null;
    const typeFloor =
      channelType && isChannelId(channelType)
        ? this.get(channelType)
        : ADMISSION_POLICY_DEFAULT;

    if (!row) {
      return {
        conversationId,
        channelType: null,
        override: null,
        typeFloor,
        updatedAt: null,
      };
    }

    return {
      conversationId,
      channelType,
      override: coercePolicy(row.override),
      typeFloor,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Upsert the admission override for a conversation. `channelType` is stored
   * for diagnostics and exemption checks but is NOT required. Passing `null`
   * for `override` deletes the row (same as `removeConversationOverride`).
   */
  setConversationOverride(
    conversationId: string,
    override: AdmissionPolicy,
    channelType?: string | null,
  ): ConversationOverrideView {
    const now = Date.now();
    const channelTypeValue = channelType ?? null;

    this.db.run(sql`
      INSERT INTO conversation_admission_override (conversation_id, channel_type, override, updated_at)
      VALUES (${conversationId}, ${channelTypeValue}, ${override}, ${now})
      ON CONFLICT (conversation_id) DO UPDATE SET
        channel_type = excluded.channel_type,
        override = excluded.override,
        updated_at = excluded.updated_at
    `);

    const typeFloor =
      channelTypeValue && isChannelId(channelTypeValue)
        ? this.get(channelTypeValue)
        : ADMISSION_POLICY_DEFAULT;

    return {
      conversationId,
      channelType: channelTypeValue,
      override,
      typeFloor,
      updatedAt: now,
    };
  }

  /**
   * Delete the per-conversation override row, reverting to the type floor.
   * Returns true when a row was deleted, false if nothing existed.
   */
  removeConversationOverride(conversationId: string): boolean {
    const existing = this.db
      .select()
      .from(conversationAdmissionOverride)
      .where(eq(conversationAdmissionOverride.conversationId, conversationId))
      .get();
    if (!existing) return false;

    this.db
      .delete(conversationAdmissionOverride)
      .where(eq(conversationAdmissionOverride.conversationId, conversationId))
      .run();
    return true;
  }
}
