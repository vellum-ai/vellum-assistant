import { eq } from "drizzle-orm";

import type { DrizzleDb } from "../../memory/db-connection.js";
import { providerConnections } from "../../memory/schema/inference.js";
import { clearConnectionProviderCache } from "../registry.js";
import {
  type Auth,
  AuthSchema,
  type ConnectionProvider,
  ConnectionProviderSchema,
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
    return [{ ...row, auth: auth.data, provider: provider.data }];
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
  return { ...row, auth: auth.data, provider: provider.data };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export type CreateConnectionInput = {
  name: string;
  provider: string;
  auth: Auth;
};

export type UpdateConnectionInput = {
  auth: Auth;
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

  const now = Date.now();
  db.insert(providerConnections).values({
    name: input.name,
    provider,
    auth: JSON.stringify(authResult.data),
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
      createdAt: now,
      updatedAt: now,
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
  db.update(providerConnections)
    .set({ auth: JSON.stringify(authResult.data), updatedAt: now })
    .where(eq(providerConnections.name, name))
    .run();

  // Drop cached adapter built against the previous auth config.
  clearConnectionProviderCache();

  return {
    ok: true,
    connection: { ...existing, auth: authResult.data, updatedAt: now },
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

const CANONICAL_CONNECTIONS: Array<{ name: string; provider: string; auth: Auth }> = [
  { name: "anthropic-managed", provider: "anthropic", auth: { type: "platform" } },
  { name: "openai-managed",    provider: "openai",    auth: { type: "platform" } },
  { name: "gemini-managed",    provider: "gemini",    auth: { type: "platform" } },
  { name: "ollama-local",      provider: "ollama",    auth: { type: "none" } },
];

/**
 * Upsert the four canonical connections on every boot. Existing rows are
 * updated to the latest provider/auth values so Vellum can push connection
 * changes to customers in new releases.
 */
export function seedCanonicalConnections(db: DrizzleDb): void {
  const now = Date.now();
  for (const { name, provider, auth } of CANONICAL_CONNECTIONS) {
    db.insert(providerConnections)
      .values({
        name,
        provider,
        auth: JSON.stringify(auth),
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
  }
}
