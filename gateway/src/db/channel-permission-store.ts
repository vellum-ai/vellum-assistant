/**
 * Gateway store for channel-permission matrix cells.
 *
 * Each row is one cell: a cascade selector (workspace default → adapter →
 * channel-type → channel-ID) × contact-type (trust class) → RiskThreshold.
 * Resolution walks the cascade most-specific-first and returns the first
 * cell present for the contact-type.
 *
 * Vocabulary lives in `@vellumai/gateway-client`
 * (`channel-permission-contract.ts`) so the gateway, the runtime evaluator,
 * and the web client share one canonical definition — same pattern as the
 * admission-policy contract.
 *
 * The per-tool-call evaluator consumes these cells through the
 * `resolve_channel_permission_threshold` IPC: the assistant's permission
 * checker threads the resolved threshold into its cascade (conversation
 * override → cell → global defaults) and composes it with tool RiskLevel
 * and the capability floor.
 */

import { and, eq, sql } from "drizzle-orm";
import {
  type ChannelPermissionCell,
  type ChannelPermissionCellRow,
  type ChannelPermissionSelector,
  isRiskThreshold,
  isTrustClass,
  type ResolveChannelPermissionRequest,
  type ResolvedChannelPermission,
} from "@vellumai/gateway-client";
import { type GatewayDb, getGatewayDb } from "./connection.js";
import { channelPermissionOverrides } from "./schema.js";

// ---------------------------------------------------------------------------
// Selector ↔ column mapping
// ---------------------------------------------------------------------------

interface SelectorColumns {
  scope: string;
  adapter: string;
  channelType: string;
  channelExternalId: string;
}

/**
 * Flatten a selector into the four key columns. Keys above the selector's
 * scope are the empty string — never NULL — so the composite unique index
 * enforces one row per cell.
 */
function selectorColumns(selector: ChannelPermissionSelector): SelectorColumns {
  switch (selector.scope) {
    case "workspace":
      return {
        scope: "workspace",
        adapter: "",
        channelType: "",
        channelExternalId: "",
      };
    case "adapter":
      return {
        scope: "adapter",
        adapter: selector.adapter,
        channelType: "",
        channelExternalId: "",
      };
    case "channel_type":
      return {
        scope: "channel_type",
        adapter: selector.adapter,
        channelType: selector.channelType,
        channelExternalId: "",
      };
    case "channel":
      return {
        scope: "channel",
        adapter: selector.adapter,
        channelType: "",
        channelExternalId: selector.channelExternalId,
      };
  }
}

/** Rebuild the typed selector from stored columns, or null for corrupt rows. */
function columnsToSelector(row: {
  scope: string;
  adapter: string;
  channelType: string;
  channelExternalId: string;
}): ChannelPermissionSelector | null {
  switch (row.scope) {
    case "workspace":
      return { scope: "workspace" };
    case "adapter":
      return row.adapter ? { scope: "adapter", adapter: row.adapter } : null;
    case "channel_type":
      return row.adapter &&
        (row.channelType === "dm" ||
          row.channelType === "private" ||
          row.channelType === "public")
        ? {
            scope: "channel_type",
            adapter: row.adapter,
            channelType: row.channelType,
          }
        : null;
    case "channel":
      return row.adapter && row.channelExternalId
        ? {
            scope: "channel",
            adapter: row.adapter,
            channelExternalId: row.channelExternalId,
          }
        : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class ChannelPermissionStore {
  private injectedDb?: GatewayDb;

  constructor(db?: GatewayDb) {
    this.injectedDb = db;
  }

  private get db(): GatewayDb {
    return this.injectedDb ?? getGatewayDb();
  }

  /**
   * Upsert a cell. Stamps `updatedAt` to the current epoch ms. The store is
   * a pure data layer — callers own any cache invalidation, matching
   * `AdmissionPolicyStore` / `TrustRuleStore`.
   */
  set(cell: ChannelPermissionCell): ChannelPermissionCellRow {
    const cols = selectorColumns(cell.selector);
    const now = Date.now();
    const noteValue = cell.note ?? null;

    this.db.run(sql`
      INSERT INTO channel_permission_overrides
        (scope, adapter, channel_type, channel_external_id, contact_type, threshold, note, updated_at)
      VALUES
        (${cols.scope}, ${cols.adapter}, ${cols.channelType}, ${cols.channelExternalId},
         ${cell.contactType}, ${cell.threshold}, ${noteValue}, ${now})
      ON CONFLICT (scope, adapter, channel_type, channel_external_id, contact_type) DO UPDATE SET
        threshold = excluded.threshold,
        note = excluded.note,
        updated_at = excluded.updated_at
    `);

    return {
      selector: cell.selector,
      contactType: cell.contactType,
      threshold: cell.threshold,
      note: noteValue,
      updatedAt: now,
    };
  }

  /**
   * List every persisted cell. Rows whose vocabulary fails contract
   * validation (e.g. a value written by a rolled-back future version) are
   * skipped rather than surfaced — the same belt-and-suspenders coercion
   * `AdmissionPolicyStore.list()` applies.
   */
  list(): ChannelPermissionCellRow[] {
    const rows = this.db.select().from(channelPermissionOverrides).all();
    const out: ChannelPermissionCellRow[] = [];
    for (const row of rows) {
      const selector = columnsToSelector(row);
      if (!selector) {
        continue;
      }
      if (!isTrustClass(row.contactType)) {
        continue;
      }
      if (!isRiskThreshold(row.threshold)) {
        continue;
      }
      out.push({
        selector,
        contactType: row.contactType,
        threshold: row.threshold,
        note: row.note,
        updatedAt: row.updatedAt,
      });
    }
    return out;
  }

  /** Read one cell, or null when it isn't set. */
  get(
    selector: ChannelPermissionSelector,
    contactType: ChannelPermissionCell["contactType"],
  ): ChannelPermissionCellRow | null {
    const cols = selectorColumns(selector);
    const row = this.db
      .select()
      .from(channelPermissionOverrides)
      .where(
        and(
          eq(channelPermissionOverrides.scope, cols.scope),
          eq(channelPermissionOverrides.adapter, cols.adapter),
          eq(channelPermissionOverrides.channelType, cols.channelType),
          eq(
            channelPermissionOverrides.channelExternalId,
            cols.channelExternalId,
          ),
          eq(channelPermissionOverrides.contactType, contactType),
        ),
      )
      .get();
    if (!row || !isRiskThreshold(row.threshold)) {
      return null;
    }
    return {
      selector,
      contactType,
      threshold: row.threshold,
      note: row.note,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Delete a cell. Returns true if a row was deleted. The existence check is
   * a separate SELECT because drizzle's bun-sqlite `.run()` surfaces no
   * rowcount through the typed API.
   */
  remove(
    selector: ChannelPermissionSelector,
    contactType: ChannelPermissionCell["contactType"],
  ): boolean {
    if (!this.get(selector, contactType)) {
      return false;
    }
    const cols = selectorColumns(selector);
    this.db
      .delete(channelPermissionOverrides)
      .where(
        and(
          eq(channelPermissionOverrides.scope, cols.scope),
          eq(channelPermissionOverrides.adapter, cols.adapter),
          eq(channelPermissionOverrides.channelType, cols.channelType),
          eq(
            channelPermissionOverrides.channelExternalId,
            cols.channelExternalId,
          ),
          eq(channelPermissionOverrides.contactType, contactType),
        ),
      )
      .run();
    return true;
  }

  /**
   * Idempotent seed: insert a cell only if none exists (ON CONFLICT DO
   * NOTHING) — a user-configured cell is never overwritten. Returns true
   * when a row was inserted.
   */
  seedCell(cell: ChannelPermissionCell): boolean {
    if (this.get(cell.selector, cell.contactType)) {
      return false;
    }
    const cols = selectorColumns(cell.selector);
    this.db.run(sql`
      INSERT INTO channel_permission_overrides
        (scope, adapter, channel_type, channel_external_id, contact_type, threshold, note, updated_at)
      VALUES
        (${cols.scope}, ${cols.adapter}, ${cols.channelType}, ${cols.channelExternalId},
         ${cell.contactType}, ${cell.threshold}, ${cell.note ?? null}, ${Date.now()})
      ON CONFLICT (scope, adapter, channel_type, channel_external_id, contact_type) DO NOTHING
    `);
    return true;
  }

  /**
   * Cascade resolution: most specific cell wins. Walks channel →
   * channel-type → adapter → workspace and returns the first cell set for
   * the contact-type, or null when no level has one. Optional query keys
   * shrink the walk — without a `channelExternalId` the channel level
   * cannot match, without a `channelType` the channel-type level cannot.
   */
  resolve(
    query: ResolveChannelPermissionRequest,
  ): ResolvedChannelPermission | null {
    const { adapter, channelType, channelExternalId, contactType } = query;

    const candidates: ChannelPermissionSelector[] = [];
    if (channelExternalId) {
      candidates.push({ scope: "channel", adapter, channelExternalId });
    }
    if (channelType) {
      candidates.push({ scope: "channel_type", adapter, channelType });
    }
    candidates.push({ scope: "adapter", adapter });
    candidates.push({ scope: "workspace" });

    for (const selector of candidates) {
      const cell = this.get(selector, contactType);
      if (cell) {
        return { threshold: cell.threshold, scope: selector.scope };
      }
    }
    return null;
  }
}
