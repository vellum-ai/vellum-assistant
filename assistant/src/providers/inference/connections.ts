import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import type { DrizzleDb } from "../../persistence/db-connection.js";
import { providerConnections } from "../../persistence/schema/inference.js";
import { getLogger } from "../../util/logger.js";
import { clearConnectionProviderCache } from "../registry.js";
import {
  VELLUM_MANAGED_CONNECTION_NAME,
  VELLUM_MANAGED_PROVIDER,
} from "../vellum-model-routing.js";

export { VELLUM_MANAGED_CONNECTION_NAME };
import {
  type Auth,
  AuthSchema,
  type ConnectionModel,
  ConnectionModelSchema,
  type ConnectionProvider,
  ConnectionProviderSchema,
  type ProviderConnection,
  PROVIDERS_REQUIRING_BASE_URL_AND_MODELS,
  VALID_CONNECTION_PROVIDERS,
} from "./auth.js";

const log = getLogger("providers/inference/connections");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseModelsColumn(raw: string | null): ConnectionModel[] | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed = z.array(ConnectionModelSchema).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function listConnections(
  db: DrizzleDb,
  filter?: { provider?: string },
): ProviderConnection[] {
  const rows = filter?.provider
    ? db
        .select()
        .from(providerConnections)
        .where(eq(providerConnections.provider, filter.provider))
        .all()
    : db.select().from(providerConnections).all();

  return rows.flatMap((row) => {
    const auth = AuthSchema.safeParse(JSON.parse(row.auth));
    if (!auth.success) return [];
    const provider = ConnectionProviderSchema.safeParse(row.provider);
    if (!provider.success) return [];
    return [
      {
        ...row,
        auth: auth.data,
        provider: provider.data,
        label: row.label ?? null,
        baseUrl: row.baseUrl ?? null,
        models: parseModelsColumn(row.models),
        isManaged: MANAGED_CONNECTION_NAMES.has(row.name),
      },
    ];
  });
}

export function getConnection(
  db: DrizzleDb,
  name: string,
): ProviderConnection | null {
  const row = db
    .select()
    .from(providerConnections)
    .where(eq(providerConnections.name, name))
    .get();

  if (!row) return null;
  const auth = AuthSchema.safeParse(JSON.parse(row.auth));
  if (!auth.success) return null;
  const provider = ConnectionProviderSchema.safeParse(row.provider);
  if (!provider.success) return null;
  return {
    ...row,
    auth: auth.data,
    provider: provider.data,
    label: row.label ?? null,
    baseUrl: row.baseUrl ?? null,
    models: parseModelsColumn(row.models),
    isManaged: MANAGED_CONNECTION_NAMES.has(row.name),
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export type CreateConnectionInput = {
  name: string;
  provider: string;
  auth: Auth;
  label?: string | null;
  baseUrl?: string | null;
  models?: ConnectionModel[] | null;
};

export type UpdateConnectionInput = {
  auth: Auth;
  label?: string | null;
  baseUrl?: string | null;
  models?: ConnectionModel[] | null;
};

export type ConnectionCreateError =
  | { code: "already_exists" }
  | { code: "invalid_provider"; provider: string }
  | { code: "invalid_auth" }
  | { code: "base_url_required" }
  | { code: "models_required" };

export type ConnectionUpdateError =
  | { code: "not_found" }
  | { code: "invalid_auth" }
  | { code: "base_url_required" }
  | { code: "models_required" };

export type ConnectionDeleteError =
  | { code: "not_found" }
  | { code: "has_references"; count: number };

export function createConnection(
  db: DrizzleDb,
  input: CreateConnectionInput,
):
  | { ok: true; connection: ProviderConnection }
  | { ok: false; error: ConnectionCreateError } {
  if (!VALID_CONNECTION_PROVIDERS.includes(input.provider as never)) {
    return {
      ok: false,
      error: { code: "invalid_provider", provider: input.provider },
    };
  }
  // Safe cast: VALID_CONNECTION_PROVIDERS.includes() guards above.
  const provider = input.provider as ConnectionProvider;

  const authResult = AuthSchema.safeParse(input.auth);
  if (!authResult.success) {
    return { ok: false, error: { code: "invalid_auth" } };
  }

  const existing = db
    .select({ name: providerConnections.name })
    .from(providerConnections)
    .where(eq(providerConnections.name, input.name))
    .get();
  if (existing) {
    return { ok: false, error: { code: "already_exists" } };
  }

  const label = input.label ?? null;
  const baseUrl = input.baseUrl ?? null;
  const models = input.models ?? null;

  if (PROVIDERS_REQUIRING_BASE_URL_AND_MODELS.has(provider)) {
    if (!baseUrl) return { ok: false, error: { code: "base_url_required" } };
    if (!models || models.length === 0) {
      return { ok: false, error: { code: "models_required" } };
    }
  }

  const now = Date.now();
  db.insert(providerConnections)
    .values({
      name: input.name,
      provider,
      auth: JSON.stringify(authResult.data),
      label,
      baseUrl,
      models: models === null ? null : JSON.stringify(models),
      createdAt: now,
      updatedAt: now,
    })
    .run();

  // Invalidate per-connection adapter cache so subsequent dispatch
  // resolves the freshly-inserted row's auth.
  clearConnectionProviderCache();

  return {
    ok: true,
    connection: {
      name: input.name,
      provider,
      auth: authResult.data,
      label,
      baseUrl,
      models,
      createdAt: now,
      updatedAt: now,
      isManaged: MANAGED_CONNECTION_NAMES.has(input.name),
    },
  };
}

export function updateConnection(
  db: DrizzleDb,
  name: string,
  input: UpdateConnectionInput,
):
  | { ok: true; connection: ProviderConnection }
  | { ok: false; error: ConnectionUpdateError } {
  const existing = getConnection(db, name);
  if (!existing) {
    return { ok: false, error: { code: "not_found" } };
  }

  const authResult = AuthSchema.safeParse(input.auth);
  if (!authResult.success) {
    return { ok: false, error: { code: "invalid_auth" } };
  }

  const nextBaseUrl =
    input.baseUrl !== undefined ? input.baseUrl : existing.baseUrl;
  const nextModels =
    input.models !== undefined ? input.models : existing.models;

  if (PROVIDERS_REQUIRING_BASE_URL_AND_MODELS.has(existing.provider)) {
    if (!nextBaseUrl)
      return { ok: false, error: { code: "base_url_required" } };
    if (!nextModels || nextModels.length === 0) {
      return { ok: false, error: { code: "models_required" } };
    }
  }

  const now = Date.now();
  const setClause: {
    auth: string;
    updatedAt: number;
    label?: string | null;
    baseUrl?: string | null;
    models?: string | null;
  } = { auth: JSON.stringify(authResult.data), updatedAt: now };
  if (input.label !== undefined) setClause.label = input.label;
  if (input.baseUrl !== undefined) setClause.baseUrl = input.baseUrl;
  if (input.models !== undefined)
    setClause.models =
      input.models === null ? null : JSON.stringify(input.models);

  db.update(providerConnections)
    .set(setClause)
    .where(eq(providerConnections.name, name))
    .run();

  // Drop cached adapter built against the previous auth config.
  clearConnectionProviderCache();

  return {
    ok: true,
    connection: {
      ...existing,
      auth: authResult.data,
      label: input.label !== undefined ? input.label : existing.label,
      baseUrl: nextBaseUrl,
      models: nextModels,
      updatedAt: now,
    },
  };
}

/**
 * Delete a connection.
 *
 * `force`: when true, delete even if profiles reference it.
 * When false, rejects if any profile in the provided profile names list
 * references this connection.
 */
export function deleteConnection(
  db: DrizzleDb,
  name: string,
  opts: { force?: boolean; referencingProfiles?: string[] } = {},
): { ok: true } | { ok: false; error: ConnectionDeleteError } {
  const existing = db
    .select({ name: providerConnections.name })
    .from(providerConnections)
    .where(eq(providerConnections.name, name))
    .get();

  if (!existing) {
    return { ok: false, error: { code: "not_found" } };
  }

  if (
    !opts.force &&
    opts.referencingProfiles &&
    opts.referencingProfiles.length > 0
  ) {
    return {
      ok: false,
      error: { code: "has_references", count: opts.referencingProfiles.length },
    };
  }

  db.delete(providerConnections)
    .where(eq(providerConnections.name, name))
    .run();

  // Evict cached adapter for the deleted connection name.
  clearConnectionProviderCache();

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Seed canonical connections (upsert, used at boot time)
// ---------------------------------------------------------------------------

/**
 * The former per-provider `*-managed` connection names, now collapsed into the
 * single `vellum` connection. They are no longer seeded, but existing installs
 * (and fresh installs seeded by migration 243) may still carry these rows until
 * a follow-up migration deletes them. They are filtered out of the connection
 * list so the UI never shows the pre-consolidation duplicates.
 */
export const LEGACY_MANAGED_CONNECTION_NAMES: ReadonlySet<string> = new Set([
  "anthropic-managed",
  "openai-managed",
  "gemini-managed",
  "fireworks-managed",
  "together-managed",
]);

const CANONICAL_CONNECTIONS: Array<{
  name: string;
  provider: string;
  auth: Auth;
  label: string;
}> = [
  {
    name: VELLUM_MANAGED_CONNECTION_NAME,
    provider: VELLUM_MANAGED_PROVIDER,
    auth: { type: "platform" },
    label: "Vellum",
  },
];

/**
 * Names of the canonical Vellum-managed connections. Seeded on every daemon
 * boot via `seedCanonicalConnections` and representing the platform-managed
 * inference route. They are write-protected at the route layer:
 *   - DELETE is blocked outright (would resurrect on next boot anyway, but
 *     blocking prevents a confusing delete → re-appear loop).
 *   - PATCH that changes `auth` is blocked (auth is locked to `{type:"platform"}`
 *     so any other value would be reverted on the next boot upsert).
 *   - PATCH that changes `label` is allowed — users may legitimately relabel the
 *     managed connection. `label` is seeded on initial INSERT and backfilled when
 *     null on subsequent boots so pre-seed installs pick up the default; a non-null
 *     user-customized label is preserved (see `seedCanonicalConnections`).
 *
 * Mirrors `MANAGED_PROFILE_NAMES` (config/seed-inference-profiles.ts).
 */
export const MANAGED_CONNECTION_NAMES: ReadonlySet<string> = new Set(
  CANONICAL_CONNECTIONS.map((c) => c.name),
);

/**
 * Upsert the canonical connections on every boot. Existing rows are
 * updated to the latest provider/auth values so Vellum can push connection
 * changes to customers in new releases.
 *
 * Label handling: the default label is seeded on initial INSERT so new
 * installs render a human-friendly name in the connections list. The boot
 * upsert deliberately leaves `label` alone on existing rows so user
 * customization is preserved; the separate backfill step below assigns the
 * default only when the existing row has `label IS NULL`, covering installs
 * that pre-date the label seed.
 */
export function seedCanonicalConnections(db: DrizzleDb): void {
  const now = Date.now();
  for (const { name, provider, auth, label } of CANONICAL_CONNECTIONS) {
    // Never clobber a pre-existing user connection that happens to share this
    // canonical name. `vellum` was not a reserved name before consolidation, so
    // an install may already have a BYOK connection keyed `vellum` (with a real
    // provider + api_key auth). Upserting it here would silently rewrite it to
    // the platform-auth sentinel and make it managed/write-protected, breaking
    // any profile that references the user's connection. Only seed/refresh when
    // the row is absent or already our sentinel (same provider).
    const existing = db
      .select({ provider: providerConnections.provider })
      .from(providerConnections)
      .where(eq(providerConnections.name, name))
      .get();
    if (existing && existing.provider !== provider) {
      log.warn(
        { name, existingProvider: existing.provider },
        `Skipping canonical seed for "${name}": a user-owned connection already claims this name.`,
      );
      continue;
    }

    db.insert(providerConnections)
      .values({
        name,
        provider,
        auth: JSON.stringify(auth),
        label,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: providerConnections.name,
        set: {
          provider,
          auth: JSON.stringify(auth),
          updatedAt: now,
        },
      })
      .run();

    // Backfill the default label on rows that pre-date label seeding so
    // existing installs pick up the friendly name. Does not overwrite a
    // user-set label.
    db.update(providerConnections)
      .set({ label, updatedAt: now })
      .where(
        and(
          eq(providerConnections.name, name),
          isNull(providerConnections.label),
        ),
      )
      .run();
  }
}
