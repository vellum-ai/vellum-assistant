import {
  isChannelConversationType,
  type ChannelConversationType,
} from "@vellumai/gateway-client";
/**
 * A plugin's reply to a verified webhook delivery, read as an inbound message.
 *
 * This is the normalize step for plugin channels, and it sits where every
 * other channel's does — `telegram/normalize.ts`, `discord/normalize.ts`,
 * `email/normalize.ts` — feeding the same `handleInbound`. The difference is
 * where the parsing happened: a built-in channel's normalizer knows the
 * vendor's payload, and a plugin's does not exist here, so the plugin parses
 * its own delivery and hands back the result. What this file does is decide
 * what of that result the gateway is willing to believe.
 *
 * ## What the plugin says, and what it does not get to
 *
 * The plugin supplies the message: who sent it, where, what it said. It does
 * not supply anything that would place that message inside the assistant.
 *
 * `sourceChannel` is stamped `plugin` here and is not readable from the reply.
 * A plugin that could name its own channel could claim `slack`, and inherit
 * Slack's admission floor, Slack's contact records, and the trust the guardian
 * granted a different surface entirely.
 *
 * The external ids are prefixed with the plugin's directory name, which the
 * gateway takes from the request path and never from the reply — the same rule
 * `signingCredentialKey` follows for secrets, for the same reason. One channel
 * id covers every installed plugin, so without the prefix two plugins whose
 * vendors both address by phone number would share conversations and contact
 * records, and either could address the other's. With it, `imessage:+1202…`
 * and `signal:+1202…` are different people to every store downstream, and
 * neither plugin can spell the other's namespace.
 *
 * The cost is real and worth stating: those same prefixes mean a plugin
 * channel's contacts are disjoint from the built-in channels' too, so a
 * guardian already verified on `phone` is a stranger on `imessage` until they
 * verify again. That is the correct default — a plugin asserting an address is
 * not the same evidence as an SMS arriving at a number Twilio owns — but it is
 * a default, not a law, and cross-channel identity linking is where it would
 * be revisited.
 *
 * ## What a reply that is not a message looks like
 *
 * Most deliveries are not turns. Delivery receipts, outbound echoes, and
 * events the plugin does not handle all get acknowledged and dropped, and the
 * plugin says so by replying without the fields. `none` is therefore the
 * ordinary case and is silent; `invalid` means the reply carried some of a
 * message but not enough of one, which is a plugin bug and says so in the log.
 */

import {
  inboundFieldSource,
  readFieldSource,
  type IngressInbound,
  type InboundFieldName,
} from "./ingress-inbound.js";
import type { PluginInboundEvent } from "./inbound-event.js";
import { canonicalizeIdentityAs } from "../verification/identity.js";

/**
 * Namespace an external id to the plugin that produced it.
 *
 * The separator is `:` and the plugin name is a safe URL path segment
 * (`SAFE_PLUGIN_NAME` in `plugin-ingress.ts`), which excludes `:`, so the
 * prefix is unambiguous: a scoped id splits back into exactly one plugin name.
 */
export function pluginScopedId(plugin: string, value: string): string {
  return `${plugin}:${value}`;
}

/**
 * The vendor payload the plugin carried forward, if it carried one.
 *
 * `raw` is what every other channel's normalizer keeps for a later stage to
 * re-read — a field the mapping did not cover, a debugging question, a
 * capability added after the fact. A plugin channel has more reason to keep it
 * than a built-in one, not less: the gateway understands only the declared
 * fields, so anything the vendor sent beyond them survives here or nowhere.
 *
 * Read as a whole object rather than through the field map, because it is not
 * a scalar and there is nothing to map. A reply that carries no object there
 * yields `{}` rather than the reply itself: `raw` means the vendor's payload,
 * and substituting the envelope would quietly redefine it.
 */
function readRaw(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object") {
    return {};
  }
  const carried = (body as Record<string, unknown>).raw;
  if (
    carried === null ||
    typeof carried !== "object" ||
    Array.isArray(carried)
  ) {
    return {};
  }
  return carried as Record<string, unknown>;
}

export type PluginInboundReading =
  | { status: "event"; event: PluginInboundEvent }
  | { status: "none" }
  | { status: "invalid"; reason: string };

export interface ReadPluginInboundOptions {
  /** Plugin directory name, from the request path. Never from the reply. */
  plugin: string;
  /** The route's declaration, which decides how the reply is read. */
  inbound: IngressInbound;
  /** The plugin's parsed reply body. */
  body: unknown;
  /** Gateway wall clock at receipt, never a plugin-supplied timestamp. */
  receivedAt: string;
}

/**
 * A plugin's reported chat type on the permission matrix's axis.
 *
 * The plugin contract documents `dm` and `channel`, and a plugin is the channel
 * here, so its word is the only signal. `channel` stays unmapped for the same
 * reason Discord's does: one word for every shared room proves nothing about
 * who can read it, and a permissive public rule must not reach a private one.
 *
 * A plugin that knows better can say so directly by sending
 * `conversationType`, which is preferred over this when present.
 */
export function pluginConversationType(
  chatType: string | undefined,
): ChannelConversationType | undefined {
  return chatType === "dm" ? "dm" : undefined;
}

/**
 * Read a plugin's reply into an inbound event, or say why there isn't one.
 *
 * A delivery is a message when it carries a sender, and with them a
 * conversation and a message id: the three the pipeline cannot proceed
 * without. Conversation and sender
 * are what the message is routed and admitted on, and the message id is the
 * dedup key that keeps a vendor's retry from starting a second turn. Content
 * is not among them — an attachment-only message is a real message with no
 * text — so an empty string is accepted and a missing field reads as one.
 *
 * All three absent is a plain acknowledgement. Some present and some missing
 * is a reply that meant to be a message and is not one, which is reported
 * rather than quietly dropped: dropping it would present a plugin bug as a
 * vendor that stopped delivering.
 */
export function readPluginInbound(
  opts: ReadPluginInboundOptions,
): PluginInboundReading {
  const { plugin, inbound, body, receivedAt } = opts;
  const read = (field: InboundFieldName) =>
    readFieldSource(body, inboundFieldSource(inbound, field));

  const conversation = read("conversationExternalId")?.trim();
  const actor = read("actorExternalId")?.trim();
  const messageId = read("externalMessageId")?.trim();

  // Naming neither a sender nor a chat is what a delivery that is not a
  // message looks like: a vendor's probe, a delivery receipt, an echo of
  // something we sent whose sender field the vendor leaves off. A message id
  // alone does not make one, and treating these as malformed would answer a
  // vendor's ordinary traffic with a 4xx, which is how a webhook gets
  // disabled at the far end. There is nobody to admit, so there is nothing to
  // gate, and only the plugin can say what the delivery meant.
  if (!conversation && !actor) {
    return { status: "none" };
  }

  // Naming one of them and not the rest is the opposite: a delivery shaped
  // like a message whose sender or address the declaration failed to find.
  // Dropping it quietly would present a manifest that no longer matches the
  // payload as a vendor that stopped delivering, and forwarding it would hand
  // the plugin a sender the gateway never checked.
  if (!conversation || !actor || !messageId) {
    const missing = [
      conversation ? null : "conversationExternalId",
      actor ? null : "actorExternalId",
      messageId ? null : "externalMessageId",
    ].filter((name): name is string => name !== null);
    return {
      status: "invalid",
      reason: `delivery is missing ${missing.join(", ")}`,
    };
  }

  // Canonicalized before the prefix, so the prefix is applied to the form
  // everything downstream compares on rather than to whatever spelling the
  // vendor happened to send. `actor` is non-empty here, so this cannot be null.
  const canonicalActor = canonicalizeIdentityAs(inbound.identity, actor!)!;

  const displayName = read("actorDisplayName")?.trim();
  const username = read("actorUsername")?.trim();
  const chatType = read("chatType")?.trim();
  // An explicit answer from the plugin wins; otherwise its chat type is mapped
  // the same way every other channel maps its own.
  const declaredConversationType = read("conversationType")?.trim();
  const conversationType = isChannelConversationType(declaredConversationType)
    ? declaredConversationType
    : pluginConversationType(chatType);

  return {
    status: "event",
    event: {
      version: "v1",
      sourceChannel: "plugin",
      receivedAt,
      message: {
        content: read("content") ?? "",
        conversationExternalId: pluginScopedId(plugin, conversation!),
        externalMessageId: pluginScopedId(plugin, messageId!),
      },
      actor: {
        actorExternalId: pluginScopedId(plugin, canonicalActor),
        ...(displayName ? { displayName } : {}),
        ...(username ? { username } : {}),
      },
      source: {
        // The dedup key doubles as the update id: a plugin channel has no
        // separate provider-assigned envelope id, and the message id is
        // already unique per delivery.
        updateId: pluginScopedId(plugin, messageId!),
        messageId: pluginScopedId(plugin, messageId!),
        ...(chatType ? { chatType } : {}),
        ...(conversationType ? { conversationType } : {}),
      },
      raw: readRaw(body),
    },
  };
}
