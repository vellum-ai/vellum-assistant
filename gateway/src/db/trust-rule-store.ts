import { and, eq, or, sql } from "drizzle-orm";
import { type GatewayDb, getGatewayDb } from "./connection.js";
import { trustRules } from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrustRule {
  id: string;
  tool: string;
  pattern: string;
  risk: "low" | "medium" | "high";
  description: string;
  origin: "default" | "user_defined";
  userModified: boolean;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ListFilters {
  origin?: string;
  tool?: string;
  includeDeleted?: boolean;
  /**
   * When true, only returns rules that are user-relevant: user_defined rules
   * plus default rules that have been modified by the user. This is the
   * default behaviour for the GET list endpoint when no `origin` filter is
   * specified.
   */
  userRelevantOnly?: boolean;
}

export interface CreateInput {
  tool: string;
  pattern: string;
  risk: string;
  description: string;
}

export interface UpdateInput {
  risk?: string;
  description?: string;
}

export interface UpsertDefaultInput {
  id: string;
  tool: string;
  pattern: string;
  risk: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const VALID_RISK_VALUES: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
]);

function assertValidRisk(value: string): asserts value is TrustRule["risk"] {
  if (!VALID_RISK_VALUES.has(value)) {
    throw new Error(
      `Invalid risk value: "${value}". Must be one of: low, medium, high`,
    );
  }
}

function nowISO(): string {
  return new Date().toISOString();
}

function toTrustRule(row: typeof trustRules.$inferSelect): TrustRule {
  // Belt-and-suspenders: validate the DB risk value. The schema constraint
  // should prevent invalid values, but default to "high" as a defensive
  // fallback if somehow one slips through.
  const risk = VALID_RISK_VALUES.has(row.risk)
    ? (row.risk as TrustRule["risk"])
    : "high";

  return {
    id: row.id,
    tool: row.tool,
    pattern: row.pattern,
    risk,
    description: row.description,
    origin: row.origin as TrustRule["origin"],
    userModified: row.userModified,
    deleted: row.deleted,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class TrustRuleStore {
  private injectedDb?: GatewayDb;

  constructor(db?: GatewayDb) {
    this.injectedDb = db;
  }

  private get db(): GatewayDb {
    return this.injectedDb ?? getGatewayDb();
  }

  /**
   * List trust rules with optional filters.
   * By default excludes soft-deleted rules.
   */
  list(filters?: ListFilters): TrustRule[] {
    const conditions = [];

    if (!filters?.includeDeleted) {
      conditions.push(eq(trustRules.deleted, false));
    }
    if (filters?.origin !== undefined) {
      conditions.push(eq(trustRules.origin, filters.origin));
    }
    if (filters?.userRelevantOnly) {
      // Only user_defined rules OR default rules that have been user-modified
      conditions.push(
        or(
          eq(trustRules.origin, "user_defined"),
          eq(trustRules.userModified, true),
        )!,
      );
    }
    if (filters?.tool !== undefined) {
      conditions.push(eq(trustRules.tool, filters.tool));
    }

    const query = this.db.select().from(trustRules);
    const rows =
      conditions.length > 0
        ? query.where(and(...conditions)).all()
        : query.all();

    return rows.map(toTrustRule);
  }

  /**
   * Fetch a single rule by ID. Returns null if not found.
   */
  getById(id: string): TrustRule | null {
    const row = this.db
      .select()
      .from(trustRules)
      .where(eq(trustRules.id, id))
      .get();
    return row ? toTrustRule(row) : null;
  }

  /**
   * Create a user-defined trust rule. Generates a UUIDv4 id.
   */
  create(input: CreateInput): TrustRule {
    assertValidRisk(input.risk);

    const now = nowISO();
    const id = crypto.randomUUID();

    this.db
      .insert(trustRules)
      .values({
        id,
        tool: input.tool,
        pattern: input.pattern,
        risk: input.risk,
        description: input.description,
        origin: "user_defined",
        userModified: false,
        deleted: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return this.getById(id)!;
  }

  /**
   * Update an existing rule's risk and/or description.
   * If the rule has origin="default", sets userModified=true.
   * Throws if not found.
   */
  update(id: string, updates: UpdateInput): TrustRule {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Trust rule not found: ${id}`);
    }

    // Early return if no fields to update — don't mark userModified for a no-op
    if (updates.risk === undefined && updates.description === undefined) {
      return existing;
    }

    if (updates.risk !== undefined) {
      assertValidRisk(updates.risk);
    }

    const setValues: Record<string, unknown> = {
      updatedAt: nowISO(),
    };

    if (updates.risk !== undefined) {
      setValues.risk = updates.risk;
    }
    if (updates.description !== undefined) {
      setValues.description = updates.description;
    }

    // If this is a default rule, mark as user-modified
    if (existing.origin === "default") {
      setValues.userModified = true;
    }

    this.db
      .update(trustRules)
      .set(setValues)
      .where(eq(trustRules.id, id))
      .run();

    return this.getById(id)!;
  }

  /**
   * Remove a trust rule.
   * - user_defined rules: hard-delete (DELETE FROM)
   * - default rules: soft-delete (set deleted=true)
   * Throws if not found.
   */
  remove(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Trust rule not found: ${id}`);
    }

    if (existing.origin === "user_defined") {
      // Hard-delete
      this.db.delete(trustRules).where(eq(trustRules.id, id)).run();
    } else {
      // Soft-delete for default rules
      this.db
        .update(trustRules)
        .set({ deleted: true, updatedAt: nowISO() })
        .where(eq(trustRules.id, id))
        .run();
    }

    return true;
  }

  /**
   * Reset a default rule to its original state.
   * Clears userModified and deleted, restores risk to originalRisk.
   * Throws if not found or if origin is not "default".
   */
  reset(
    id: string,
    originalRisk: string,
    originalDescription?: string,
  ): TrustRule {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Trust rule not found: ${id}`);
    }
    if (existing.origin !== "default") {
      throw new Error(`Cannot reset non-default rule: ${id}`);
    }

    const updates: Record<string, unknown> = {
      userModified: false,
      deleted: false,
      risk: originalRisk,
      updatedAt: nowISO(),
    };
    if (originalDescription !== undefined) {
      updates.description = originalDescription;
    }

    this.db
      .update(trustRules)
      .set(updates)
      .where(eq(trustRules.id, id))
      .run();

    return this.getById(id)!;
  }

  /**
   * Insert or update a default rule. On conflict (tool, pattern), updates
   * risk and description ONLY IF origin='default' AND user_modified=0 AND
   * deleted=0. This implements the three-guard upsert.
   *
   * Uses raw SQL because Drizzle ORM doesn't support conditional ON CONFLICT
   * updates natively.
   */
  upsertDefault(input: UpsertDefaultInput): void {
    const now = nowISO();

    this.db.run(sql`
      INSERT INTO trust_rules (id, tool, pattern, risk, description, origin, user_modified, deleted, created_at, updated_at)
      VALUES (${input.id}, ${input.tool}, ${input.pattern}, ${input.risk}, ${input.description}, 'default', 0, 0, ${now}, ${now})
      ON CONFLICT (tool, pattern) DO UPDATE SET
        risk = excluded.risk,
        description = excluded.description,
        updated_at = excluded.updated_at
      WHERE origin = 'default' AND user_modified = 0 AND deleted = 0
    `);
  }

  /**
   * Return all active (non-deleted) rules, optionally filtered by tool.
   * This is the query the cache will use.
   */
  listActive(tool?: string): TrustRule[] {
    const conditions = [eq(trustRules.deleted, false)];

    if (tool !== undefined) {
      conditions.push(eq(trustRules.tool, tool));
    }

    const rows = this.db
      .select()
      .from(trustRules)
      .where(and(...conditions))
      .all();

    return rows.map(toTrustRule);
  }
}
