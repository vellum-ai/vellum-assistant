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
 * - **Where each field lives** is declared here, so the gateway can find the
 *   sender and the conversation in a payload whose shape it does not know.
 *   That is what lets the gate run before anything is forwarded.
 *
 * Nothing here classifies a delivery. Which events mean what is the plugin's
 * business, and every event reaches it; the gateway reads only what it needs
 * to decide whether the sender may reach the assistant at all. A delivery with
 * no sender to find, a vendor's delivery probe among them, is not a message
 * the gateway can gate and is left for the plugin to interpret.
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
 * Where one field comes from.
 *
 * A bare path is the shorthand. The object form adds the two things a real
 * vendor payload needs and a single path cannot express:
 *
 * `from` may list several paths, tried in order, first non-empty wins. Photon
 * puts the conversation on `message.space.id` and falls back to `space.id`
 * depending on the delivery. In code that is `message.space ?? event.space`:
 * a fallback chain, not a second field.
 *
 * `map` and `default` turn a vendor's vocabulary into ours. Photon reports a
 * platform per message and the plugin collapses it to `imessage` or `sms`,
 * because SMS sender ids are spoofable and iMessage identities are not. That
 * is a distinction admission acts on, so it has to survive normalization.
 * Keys are matched case-insensitively and folded at parse time, so a
 * declaration may spell one the way the wire does. Matching
 * is case-insensitive and `default` is what an unmatched or absent value
 * becomes, which is how "anything that is not explicitly iMessage reads as
 * sms" stays the conservative answer rather than a guess.
 */
const InboundFieldSourceSchema = z.union([
  InboundFieldPathSchema,
  z.array(InboundFieldPathSchema).min(1),
  z
    .object({
      from: z.union([
        InboundFieldPathSchema,
        z.array(InboundFieldPathSchema).min(1),
      ]),
      map: z
        .record(z.string(), z.string())
        .transform((entries) =>
          Object.fromEntries(
            Object.entries(entries).map(([key, value]) => [
              key.toLowerCase(),
              value,
            ]),
          ),
        )
        .optional(),
      default: z.string().optional(),
    })
    .strict(),
]);
export type InboundFieldSource = z.infer<typeof InboundFieldSourceSchema>;

/** The paths a source tries, in order. */
export function fieldSourcePaths(source: InboundFieldSource): string[] {
  if (typeof source === "string") {
    return [source];
  }
  if (Array.isArray(source)) {
    return source;
  }
  return typeof source.from === "string" ? [source.from] : source.from;
}

/**
 * Read one field, following the fallback chain and applying any mapping.
 *
 * Returns undefined when nothing resolved and no default was declared, which
 * is what a caller checking a required field tests.
 */
export function readFieldSource(
  body: unknown,
  source: InboundFieldSource,
): string | undefined {
  const mapping =
    typeof source === "string" || Array.isArray(source) ? undefined : source;

  for (const path of fieldSourcePaths(source)) {
    const value = readInboundField(body, path)?.trim();
    if (!value) {
      continue;
    }
    if (!mapping) {
      return value;
    }
    // Case-insensitive because a vendor spelling it `iMessage` and `imessage`
    // across two endpoints is the ordinary case, and a mapping that missed on
    // capitalisation would silently fall through to the conservative default.
    const mapped = mapping.map?.[value.toLowerCase()];
    return mapped ?? mapping.default ?? value;
  }
  return mapping?.default;
}

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
    content: InboundFieldSourceSchema.optional(),
    conversationExternalId: InboundFieldSourceSchema.optional(),
    externalMessageId: InboundFieldSourceSchema.optional(),
    actorExternalId: InboundFieldSourceSchema.optional(),
    actorDisplayName: InboundFieldSourceSchema.optional(),
    actorUsername: InboundFieldSourceSchema.optional(),
    chatType: InboundFieldSourceSchema.optional(),
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

/** Where a field is read from, after the manifest's overrides. */
export function inboundFieldSource(
  inbound: IngressInbound,
  field: InboundFieldName,
): InboundFieldSource {
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
  const fields = INBOUND_FIELD_NAMES.map((name) => {
    const source = inboundFieldSource(inbound, name);
    return `${name}=${
      typeof source === "string"
        ? source
        : JSON.stringify(canonicalJson(source))
    }`;
  }).sort();

  return [inbound.identity, ...fields].join(" ");
}

/**
 * Key-sorted all the way down, so an encoding depends on what a declaration
 * means rather than on the order its author typed.
 *
 * Shallow sorting is not enough: a plugin that only reorders the keys inside a
 * field's `map` reads every field from the same place and yet would digest
 * differently, which drops an approved declaration back to pending and stops
 * serving it until a guardian approves the identical thing again.
 */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, nested]) => [key, canonicalJson(nested)]),
  );
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
    if (cursor === null || typeof cursor !== "object") {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === "string" ? cursor : undefined;
}
