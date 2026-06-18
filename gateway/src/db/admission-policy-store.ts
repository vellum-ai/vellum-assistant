import { eq, sql } from "drizzle-orm";
import {
  ADMISSION_FLOOR as ADMISSION_FLOOR_CONTRACT,
  ADMISSION_POLICY_DEFAULT as ADMISSION_POLICY_DEFAULT_CONTRACT,
  ADMISSION_POLICY_VALUES as ADMISSION_POLICY_VALUES_CONTRACT,
  type AdmissionPolicy,
  isAdmissionPolicy as isAdmissionPolicyContract,
} from "@vellumai/gateway-client";
import { type GatewayDb, getGatewayDb } from "./connection.js";
import { channelAdmissionPolicy } from "./schema.js";
import { type ChannelId, isChannelId } from "../channels/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-channel inbound admission policy — ordered from most-restrictive
 * (`no_one`, hard kill switch) to most-permissive (`strangers`, admits any
 * sender). See plan section 2.3.
 *
 * Vocabulary is centralized in `@vellumai/gateway-client` so the gateway
 * (storage + kill switch) and the runtime (admission stage) share one
 * canonical type.
 */
export type { AdmissionPolicy } from "@vellumai/gateway-client";

export const ADMISSION_POLICY_VALUES: ReadonlyArray<AdmissionPolicy> =
  ADMISSION_POLICY_VALUES_CONTRACT;

export const VALID_ADMISSION_POLICY_VALUES: ReadonlySet<string> = new Set(
  ADMISSION_POLICY_VALUES_CONTRACT,
);

/**
 * Read-side default applied when a channel has no row in the DB. Matches
 * today's effective semantics: guardian + active contacts admitted,
 * strangers denied. See plan section 2.2.
 */
export const ADMISSION_POLICY_DEFAULT: AdmissionPolicy =
  ADMISSION_POLICY_DEFAULT_CONTRACT;

/**
 * Minimum trust rank required for each policy. Higher rank = more trusted.
 * `no_one` is 5 — above the maximum guardian rank (4) — so no class is ever
 * admitted. See plan section 2.4 for the rank table (guardian=4,
 * trusted_contact=3, unverified_contact=2, unknown=1; blocked/revoked=0).
 */
export const ADMISSION_FLOOR: Record<AdmissionPolicy, number> =
  ADMISSION_FLOOR_CONTRACT;

export interface AdmissionPolicyRow {
  channelType: ChannelId;
  policy: AdmissionPolicy;
  note: string | null;
  updatedAt: number;
}

/**
 * Internal channels exempt from admission policy. Mirrors
 * ADMISSION_POLICY_EXEMPT_CHANNELS in `packages/gateway-client`.
 *
 * `phone` is exempt until Twilio voice ingress reads AdmissionPolicyStore.
 * `vellum` is NOT exempt — its floor is still enforced at runtime — but it is
 * hidden from the configurable UI (see ADMISSION_POLICY_HIDDEN_CHANNELS), so it
 * is intentionally absent here.
 */
export const EXEMPT_CHANNEL_TYPES = new Set<string>(["platform", "a2a", "phone"]);

export function isExemptChannelType(channelType: string): boolean {
  return EXEMPT_CHANNEL_TYPES.has(channelType);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isAdmissionPolicy(value: unknown): value is AdmissionPolicy {
  return isAdmissionPolicyContract(value);
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

  /**
   * Insert a default row for a channel only if one does not already exist.
   * Idempotent and non-destructive — a user-configured row is never
   * overwritten (ON CONFLICT DO NOTHING). Used by the startup seed so the
   * read paths can assume a row exists rather than each re-deriving defaults.
   */
  seedDefault(channelType: ChannelId, policy: AdmissionPolicy): void {
    this.db.run(sql`
      INSERT INTO channel_admission_policy (channel_type, policy, note, updated_at)
      VALUES (${channelType}, ${policy}, ${null}, ${Date.now()})
      ON CONFLICT (channel_type) DO NOTHING
    `);
  }
}
