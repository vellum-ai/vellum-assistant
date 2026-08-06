import type { ConfigGetResponse } from "@/generated/daemon/types.gen";

type ProfileEntry = NonNullable<
  NonNullable<ConfigGetResponse["llm"]>["profiles"]
>[string];

/**
 * The daemon's sentinel for the platform-managed inference route, used as
 * both a profile's routing-identity `provider` and the `provider` column of
 * the single provider-agnostic managed connection row. It is never a real
 * LLM provider, which is why it identifies the billed route on both.
 */
export const VELLUM_MANAGED_ROUTE = "vellum";

/**
 * The daemon's other routing identity: a `chatgpt` profile carries no binding
 * of its own and dispatches through the ChatGPT subscription connection, so
 * it is never the billed route. Written only through the API/CLI — the
 * provider picker offers ChatGPT as a connection, not a provider.
 */
const CHATGPT_ROUTE = "chatgpt";

/**
 * Whether a profile dispatches through the platform-billed Vellum route, or
 * null when its entry doesn't say.
 *
 * Two shapes mean the same route. A profile written against a current daemon
 * carries the `vellum` routing identity as its provider and no binding. One
 * written against a daemon that predates the identity carries the model's
 * managed upstream (e.g. `fireworks`) bound to the provider-agnostic `vellum`
 * connection — still platform-billed, and still on disk after the daemon
 * upgrades, so reading the provider alone would call it BYO. The binding is
 * judged by the connection row's own provider, which is what makes a
 * connection the managed one (a user-owned row may claim the `vellum` name).
 *
 * The `chatgpt` identity is the mirror case: it names no binding either, and
 * dispatches through the ChatGPT subscription connection, so it is never
 * billed to credits.
 *
 * Null for anything the entry can't answer: a profile that names no
 * connection (dispatch auto-resolves one by provider), a binding with no
 * matching row, and most notably a `mix` profile, which carries no route of
 * its own and whose arm is chosen by a conversation-seeded weighted pick
 * inside the daemon's resolver. Callers must read null as "unknown" and fall
 * back to whatever is safe for them, never as "not billed to credits".
 */
export function profileUsesVellumCredits(
  entry: ProfileEntry,
  connections: readonly { name: string; provider: string }[],
): boolean | null {
  if (entry.provider === VELLUM_MANAGED_ROUTE) {
    return true;
  }
  if (entry.provider === CHATGPT_ROUTE) {
    return false;
  }
  if (!entry.provider || !entry.provider_connection) {
    return null;
  }
  const bound = connections.find((c) => c.name === entry.provider_connection);
  return bound ? bound.provider === VELLUM_MANAGED_ROUTE : null;
}
