/**
 * Injective per-plugin namespacing shared by the plugin-owned durable store
 * (SQL table prefixes) and the plugin-owned vector store (Qdrant collection
 * names). Both surfaces isolate plugins by deriving a name prefix from the
 * host id, and both must keep distinct plugins in distinct namespaces — so the
 * derivation lives here as the single source of truth.
 *
 * The prefix is injective: sanitizing a host id to the `[a-z0-9_]` alphabet is
 * lossy (`foo-bar`, `foo_bar`, and `foo.bar` all reduce to `foo_bar`), so two
 * plugins with colliding sanitized names would otherwise share a prefix and
 * could read or write each other's tables / vector points. Folding a short
 * digest of the UNSANITIZED id into the prefix restores injectivity while
 * keeping every character within the `[a-z0-9_]` alphabet (so the prefix is
 * safe both as an unquoted SQL identifier and as a Qdrant collection name).
 */

import { createHash } from "node:crypto";

/**
 * Reduce a host id to the `[a-z0-9_]` alphabet. Plugin ids are kebab/dot-cased
 * package names (`vellum-memory`, `@scope/pkg`); collapse every other character
 * to `_`.
 *
 * Lossy by design (distinct ids can share a sanitized form) — injectivity of
 * the namespace prefix is restored by {@link hostIdHash}, not by this function.
 */
export function sanitizeHostId(hostId: string): string {
  return hostId.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/**
 * Short, stable hex digest of the raw (unsanitized) host id. Folded into the
 * namespace prefix so distinct raw ids yield distinct prefixes even when their
 * sanitized forms collide. Hex is already within the `[a-z0-9_]` alphabet.
 * Twelve hex chars (48 bits) make an accidental collision across a handful of
 * co-installed plugins negligible.
 */
export function hostIdHash(hostId: string): string {
  return createHash("sha256").update(hostId).digest("hex").slice(0, 12);
}

/**
 * Injective per-plugin namespace prefix: `plugin_<sanitized>_<hash>_`. Distinct
 * raw host ids always map to distinct prefixes (via {@link hostIdHash}), so two
 * plugins can never share a namespace even when their sanitized ids collide.
 * Shared by the SQL table prefix and the Qdrant collection prefix so the two
 * isolation surfaces stay consistent.
 */
export function pluginNamespacePrefix(hostId: string): string {
  return `plugin_${sanitizeHostId(hostId)}_${hostIdHash(hostId)}_`;
}
