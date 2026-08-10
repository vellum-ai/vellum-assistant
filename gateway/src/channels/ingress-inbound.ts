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

/* ------------------------------------------------------------------ *
 * Conditions — deciding what a delivery is
 * ------------------------------------------------------------------ */

/**
 * One test against the delivery, as data.
 *
 * Deliberately a closed vocabulary rather than an expression language. The
 * manifest is untrusted input evaluated against an attacker-authored document,
 * so the set of things a condition can do is fixed here and a plugin composes
 * from it — no operators to escape, nothing to evaluate, no way to reach a
 * prototype or spend unbounded time.
 *
 * Exactly one operator per condition, which keeps "what does this mean" a
 * question with one answer. `equals` and `in` compare strings and nothing
 * else: a wire value that is not a string fails rather than being coerced,
 * because coercion is how `"false"` comes to mean `false`.
 */
const IngressConditionSchema = z
  .object({
    path: InboundFieldPathSchema,
    equals: z.string().optional(),
    in: z.array(z.string()).min(1).optional(),
    /**
     * True: the path must resolve to a non-empty string. False: it must not.
     * "Absent" and "present but empty" are one answer, because a vendor that
     * sends `""` for a field it has nothing to say about is the common case
     * and treating that as present strands the delivery.
     */
    present: z.boolean().optional(),
  })
  .strict()
  .refine(
    (c) =>
      [c.equals, c.in, c.present].filter((v) => v !== undefined).length === 1,
    { message: "a condition must use exactly one of equals, in, or present" },
  );
export type IngressCondition = z.infer<typeof IngressConditionSchema>;

/**
 * Whether a delivery satisfies one condition.
 *
 * A path that resolves to a non-string reads as absent, matching
 * {@link readInboundField}: "not there" and "there but not a string" are the
 * same answer everywhere in this file, so a malformed payload cannot satisfy
 * a test by accident.
 */
export function conditionHolds(
  body: unknown,
  condition: IngressCondition,
): boolean {
  const value = readInboundField(body, condition.path)?.trim();

  if (condition.present !== undefined) {
    return condition.present ? Boolean(value) : !value;
  }
  if (condition.equals !== undefined) {
    return value === condition.equals;
  }
  return value !== undefined && condition.in!.includes(value);
}

/** Whether every condition holds. An empty list holds vacuously. */
export function allConditionsHold(
  body: unknown,
  conditions: readonly IngressCondition[],
): boolean {
  return conditions.every((condition) => conditionHolds(body, condition));
}

/**
 * Where one field comes from.
 *
 * A bare path is the shorthand. The object form adds the two things a real
 * vendor payload needs and a single path cannot express:
 *
 * `from` may list several paths, tried in order, first non-empty wins. Photon
 * puts the conversation on `message.space.id` and falls back to `space.id`
 * depending on the delivery, which in code is `message.space ?? event.space` —
 * a fallback chain, not a second field.
 *
 * `map` and `default` turn a vendor's vocabulary into ours. Photon reports a
 * platform per message and the plugin collapses it to `imessage` or `sms`,
 * because SMS sender ids are spoofable and iMessage identities are not — a
 * distinction admission acts on, so it has to survive normalization. Matching
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
      map: z.record(z.string(), z.string()).optional(),
      default: z.string().optional(),
    })
    .strict(),
]);
export type InboundFieldSource = z.infer<typeof InboundFieldSourceSchema>;

/** The paths a source tries, in order. */
export function fieldSourcePaths(source: InboundFieldSource): string[] {
  if (typeof source === "string") return [source];
  if (Array.isArray(source)) return source;
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
    if (!value) continue;
    if (!mapping) return value;
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
  /**
   * What must hold for a delivery to be a message at all.
   *
   * Empty by default, which reads as "every delivery is a message" — right for
   * a vendor with one event type and wrong for every vendor that also sends
   * receipts and echoes. Photon declares `event === "messages"` and
   * `direction` inbound; Comms declares its own two names.
   */
  when: z.array(IngressConditionSchema).default([]),
  /**
   * What identifies the vendor's own delivery test.
   *
   * A probe carries no sender and no content, so it can never be a message and
   * every required-field check would report it as a broken one. It is named
   * separately because reaching us proves registration, the signing secret and
   * routing all work — the only confirmation of inbound available without
   * waiting for a human to send something.
   */
  probe: z.array(IngressConditionSchema).default([]),
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
    return `${name}=${typeof source === "string" ? source : JSON.stringify(sortKeys(source))}`;
  }).sort();
  const conditions = (label: string, list: readonly IngressCondition[]) =>
    list.map((c) => `${label}:${JSON.stringify(sortKeys(c))}`).sort();

  return [
    inbound.identity,
    ...conditions("when", inbound.when),
    ...conditions("probe", inbound.probe),
    ...fields,
  ].join(" ");
}

/** Key-sorted shallow copy, so an encoding does not depend on author order. */
function sortKeys(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
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
