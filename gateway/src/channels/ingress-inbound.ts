/**
 * How a plugin's reply to a webhook delivery becomes an inbound message.
 *
 * The gateway already forwards every verified delivery to the plugin route
 * that declared it and reads the reply. A route declaring `inbound` says that
 * reply is not just an acknowledgement: it carries the message, normalized by
 * the plugin, for the gateway to run through admission, trust resolution, the
 * verification and invite intercepts, and on to the runtime. Nothing new is
 * opened to do it — no plugin-to-gateway callback, no second authentication —
 * because the delivery the gateway already authenticated is the only thing
 * that can produce one.
 *
 * The plugin does the parsing, which is the whole reason it exists: only it
 * knows what its vendor sends. What it cannot decide for itself is anything
 * that would be a claim about the assistant rather than about the message, and
 * that is what this declaration covers:
 *
 * - **Which channel it speaks as** is not declarable at all. The gateway
 *   stamps `plugin` and prefixes the plugin's own directory name onto every
 *   external id, so no reply can attribute a message to Slack, to another
 *   plugin, or to a contact record it does not own.
 * - **What kind of address the sender's id is** is declared here, because the
 *   answer decides whether `+1 (202) 555-0142` and `+12025550142` are the same
 *   person and the gateway cannot tell by looking.
 * - **Where each field lives in the reply** is declared here when the reply is
 *   not already in the canonical shape, so a plugin that would rather hand
 *   back its own structure can, without the gateway learning a vendor format.
 *
 * The whole declaration is part of `ingressDeclarationDigest`, so a route
 * cannot start delivering messages — or start reading them differently — under
 * an approval a guardian granted for something else.
 */

import { z } from "zod";

/**
 * A field's location in the plugin's reply, as dotted object keys.
 *
 * Deliberately not JSONPath or JSON Pointer. This reads one scalar out of one
 * object, the manifest is untrusted input, and every expression syntax that
 * does more than that has to be evaluated against an attacker-authored
 * document. Segments are identifier-shaped, so a path can never index an
 * array, never reach a prototype (`__proto__` is a legal identifier but the
 * reader refuses it explicitly), and never carry a wildcard.
 */
const InboundFieldPathSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/,
    'field path must be dotted identifiers, e.g. "message.content"',
  )
  .refine((p) => !p.split(".").includes("__proto__"), {
    message: "field path must not traverse __proto__",
  });

/**
 * Per-field overrides of {@link INBOUND_FIELD_DEFAULTS}.
 *
 * Only the fields whose location differs need naming; anything absent keeps
 * its default path. Strict, so a misspelled field name is rejected with the
 * rest of the manifest rather than silently read as "no override" — which
 * would present a typo as a plugin that stopped sending display names.
 */
const InboundFieldsSchema = z
  .object({
    content: InboundFieldPathSchema.optional(),
    conversationExternalId: InboundFieldPathSchema.optional(),
    externalMessageId: InboundFieldPathSchema.optional(),
    actorExternalId: InboundFieldPathSchema.optional(),
    actorDisplayName: InboundFieldPathSchema.optional(),
    actorUsername: InboundFieldPathSchema.optional(),
    chatType: InboundFieldPathSchema.optional(),
  })
  .strict();

export type InboundFieldName = keyof z.infer<typeof InboundFieldsSchema>;

/**
 * Where each normalized field is read from when the manifest does not say
 * otherwise.
 *
 * The defaults are the shape of `PluginInboundEvent` — the contract the plugin
 * SDK already exports — so a plugin that returns what it was built to return
 * declares `"inbound": {}` and nothing more. The `satisfies` clause ties this
 * to the schema above, so a field can never be declarable without a default or
 * carry one nothing reads.
 */
export const INBOUND_FIELD_DEFAULTS = {
  content: "message.content",
  conversationExternalId: "message.conversationExternalId",
  externalMessageId: "message.externalMessageId",
  actorExternalId: "actor.actorExternalId",
  actorDisplayName: "actor.displayName",
  actorUsername: "actor.username",
  chatType: "source.chatType",
} as const satisfies Record<InboundFieldName, string>;

const INBOUND_FIELD_NAMES = Object.keys(
  INBOUND_FIELD_DEFAULTS,
) as InboundFieldName[];

/**
 * What the sender's id is, so it can be compared with the ones already stored.
 *
 * `opaque` (the default) is right for a platform-stable id and is the only
 * safe guess, because rewriting an id that was already canonical is how a
 * returning sender stops matching their own contact record.
 */
export const InboundIdentitySchema = z.enum(["opaque", "phone", "email"]);
export type InboundIdentity = z.infer<typeof InboundIdentitySchema>;

export const IngressInboundSchema = z.object({
  identity: InboundIdentitySchema.default("opaque"),
  fields: InboundFieldsSchema.default({}),
});
export type IngressInbound = z.infer<typeof IngressInboundSchema>;

/** The path a field is read from, after the manifest's overrides. */
export function inboundFieldPath(
  inbound: IngressInbound,
  field: InboundFieldName,
): string {
  return inbound.fields[field] ?? INBOUND_FIELD_DEFAULTS[field];
}

/**
 * Stable encoding of an inbound declaration, for the approval digest.
 *
 * Resolved rather than as-written: two manifests that read the same fields the
 * same way are the same grant, whether one spelled a default out or not. That
 * also means introducing a field with a default does not re-digest every
 * manifest that predates it, provided the default matches what those manifests
 * were already getting.
 */
export function canonicalInbound(inbound: IngressInbound): string {
  const fields = INBOUND_FIELD_NAMES.map(
    (name) => `${name}=${inboundFieldPath(inbound, name)}`,
  ).sort();
  return [inbound.identity, ...fields].join(" ");
}

/**
 * Read one field out of a plugin's reply.
 *
 * Returns undefined for anything that is not a string sitting at exactly that
 * path — a missing key, a null, an object, a number. A caller deciding whether
 * a reply carries a message at all depends on that: "absent" and "present but
 * the wrong type" are the same answer, so a malformed reply cannot half-build
 * an event.
 */
export function readInboundField(
  body: unknown,
  path: string,
): string | undefined {
  let cursor: unknown = body;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cursor, segment))
      return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === "string" ? cursor : undefined;
}
