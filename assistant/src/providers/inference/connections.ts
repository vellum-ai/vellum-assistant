import { and, eq, isNull } from "drizzle-orm";

import type { DrizzleDb } from "../../memory/db-connection.js";
import { providerConnections } from "../../memory/schema/inference.js";
import { clearConnectionProviderCache } from "../registry.js";
import {
  type Auth,
  AuthSchema,
  type ConnectionProvider,
  ConnectionProviderSchema,
  type ConnectionStatus,
  ConnectionStatusSchema,
  type ProviderConnection,
  VALID_CONNECTION_PROVIDERS,
} from "./auth.js";

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function listConnections(
  db: DrizzleDb,
  filter?: { provider?: string },
): ProviderConnection[] {
  const rows = filter?.provider
    ? db.select().from(providerConnections).where(eq(providerConnections.provider, filter.provider)).all()
    : db.select().from(providerConnections).all();

  return rows.flatMap((row) => {
    const auth = AuthSchema.safeParse(JSON.parse(row.auth));
    if (!auth.success) return [];
    const provider = ConnectionProviderSchema.safeParse(row.provider);
    if (!provider.success) return [];
    const statusResult = ConnectionStatusSchema.safeParse(row.status);
    const status: ConnectionStatus = statusResult.success ? statusResult.data : "active";
    return [{
      ...row,
      auth: auth.data,
      provider: provider.data,
      status,
      label: row.label ?? null,
      isManaged: MANAGED_CONNECTION_NAMES.has(row.name),
    }];
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
  const statusResult = ConnectionStatusSchema.safeParse(row.status);
  const status: ConnectionStatus = statusResult.success ? statusResult.data : "active";
  return {
    ...row,
    auth: auth.data,
    provider: provider.data,
    status,
    label: row.label ?? null,
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
  status?: ConnectionStatus;
  label?: string | null;
};

export type UpdateConnectionInput = {
  auth: Auth;
  status?: ConnectionStatus;
  label?: string | null;
};

export type ConnectionCreateError =
  | { code: "already_exists" }
  | { code: "invalid_provider"; provider: string }
  | { code: "invalid_auth" };

export type ConnectionUpdateError =
  | { code: "not_found" }
  | { code: "invalid_auth" };

export type ConnectionDeleteError =
  | { code: "not_found" }
  | { code: "has_references"; count: number };

export function createConnection(
  db: DrizzleDb,
  input: CreateConnectionInput,
): { ok: true; connection: ProviderConnection } | { ok: false; error: ConnectionCreateError } {
  if (!VALID_CONNECTION_PROVIDERS.includes(input.provider as never)) {
    return { ok: false, error: { code: "invalid_provider", provider: input.provider } };
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

  const status = input.status ?? "active";
  const label = input.label ?? null;

  const now = Date.now();
  db.insert(providerConnections).values({
    name: input.name,
    provider,
    auth: JSON.stringify(authResult.data),
    status,
    label,
    createdAt: now,
    updatedAt: now,
  }).run();

  // Invalidate per-connection adapter cache so subsequent dispatch
  // resolves the freshly-inserted row's auth.
  clearConnectionProviderCache();

  return {
    ok: true,
    connection: {
      name: input.name,
      provider,
      auth: authResult.data,
      status,
      label,
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
): { ok: true; connection: ProviderConnection } | { ok: false; error: ConnectionUpdateError } {
  const existing = getConnection(db, name);
  if (!existing) {
    return { ok: false, error: { code: "not_found" } };
  }

  const authResult = AuthSchema.safeParse(input.auth);
  if (!authResult.success) {
    return { ok: false, error: { code: "invalid_auth" } };
  }

  const now = Date.now();
  const setClause: {
    auth: string;
    updatedAt: number;
    status?: string;
    label?: string | null;
  } = { auth: JSON.stringify(authResult.data), updatedAt: now };
  if (input.status !== undefined) setClause.status = input.status;
  if (input.label !== undefined) setClause.label = input.label;

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
      status: input.status !== undefined ? input.status : existing.status,
      label: input.label !== undefined ? input.label : existing.label,
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

  if (!opts.force && opts.referencingProfiles && opts.referencingProfiles.length > 0) {
    return {
      ok: false,
      error: { code: "has_references", count: opts.referencingProfiles.length },
    };
  }

  db.delete(providerConnections).where(eq(providerConnections.name, name)).run();

  // Evict cached adapter for the deleted connection name.
  clearConnectionProviderCache();

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Seed canonical connections (upsert, used at boot time)
// ---------------------------------------------------------------------------

const CANONICAL_CONNECTIONS: Array<{
  name: string;
  provider: string;
  auth: Auth;
  label: string;
}> = [
  { name: "anthropic-managed", provider: "anthropic", auth: { type: "platform" }, label: "Anthropic" },
  { name: "openai-managed",    provider: "openai",    auth: { type: "platform" }, label: "OpenAI" },
  { name: "gemini-managed",    provider: "gemini",    auth: { type: "platform" }, label: "Google Gemini" },
];

/**
 * Names of the canonical Vellum-managed connections. These are seeded on every
 * daemon boot via `seedCanonicalConnections` and represent the platform-managed
 * inference route. They are write-protected at the route layer:
 *   - DELETE is blocked outright (would resurrect on next boot anyway, but
 *     blocking prevents a confusing delete → re-appear loop).
 *   - PATCH that changes `auth` is blocked (auth is locked to `{type:"platform"}`
 *     so any other value would be reverted on the next boot upsert).
 *   - PATCH that changes `label` and/or `status` is allowed — users may legitimately
 *     disable or relabel the managed connection. `status` is never touched by the
 *     boot upsert. `label` is seeded on initial INSERT and backfilled when null
 *     on subsequent boots so pre-seed installs pick up the default; a non-null
 *     user-customized label is preserved (see `seedCanonicalConnections`).
 *
 * Mirrors `MANAGED_PROFILE_NAMES` (config/seed-inference-profiles.ts).
 */
export const MANAGED_CONNECTION_NAMES: ReadonlySet<string> = new Set(
  CANONICAL_CONNECTIONS.map((c) => c.name),
);

/**
 * Upsert the three canonical connections on every boot. Existing rows are
 * updated to the latest provider/auth values so Vellum can push connection
 * changes to customers in new releases.
 *
 * Label handling: the default label is seeded on initial INSERT so new
 * installs render a human-friendly name in the connections list. The boot
 * upsert deliberately leaves `label` alone on existing rows so user
 * customization is preserved; the separate backfill step below assigns the
 * default only when the existing row has `label IS NULL`, covering installs
 * that pre-date the label seed.
 *
 * Status handling: the upsert never touches `status` so user customization
 * is preserved across reboots. New rows default to `status: "active"` via the
 * column default. Off-platform installs flip the three canonical rows to
 * `status: "disabled"` ONCE at hatch time via
 * `disableManagedConnectionsForByokHatch` (called from `seedInferenceProfiles`
 * when `isHatch && !isPlatform`); subsequent boots leave whatever the user
 * has chosen alone, so a post-hatch re-enable persists.
 */
export function seedCanonicalConnections(db: DrizzleDb): void {
  const now = Date.now();
  for (const { name, provider, auth, label } of CANONICAL_CONNECTIONS) {
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
      .where(and(eq(providerConnections.name, name), isNull(providerConnections.label)))
      .run();
  }
}

/**
 * Flip the three canonical managed connections to `status: "disabled"` at
 * hatch time on BYOK (off-platform) installs.
 *
 * Why hatch-time only: managed connections need platform auth that a fresh
 * BYOK user doesn't have yet, so surfacing them as enabled in the picker
 * would let users pick an unusable option on day one. But this is a
 * first-time-only default — the moment the user explicitly flips one
 * back to active (e.g. after logging into Vellum), we never want a daemon
 * restart to revert that. `seedCanonicalConnections` leaves `status` alone
 * on the UPDATE path, and this helper is invoked ONLY from
 * `seedInferenceProfiles`'s `isHatch && !isPlatform` branch. Subsequent
 * non-hatch boots never call it.
 *
 * Idempotent: a second hatch (workspace reset) re-disables the rows, which
 * is the right call — re-hatch means re-onboard.
 */
export function disableManagedConnectionsForByokHatch(db: DrizzleDb): void {
  const now = Date.now();
  for (const name of MANAGED_CONNECTION_NAMES) {
    db.update(providerConnections)
      .set({ status: "disabled", updatedAt: now })
      .where(eq(providerConnections.name, name))
      .run();
  }
}
