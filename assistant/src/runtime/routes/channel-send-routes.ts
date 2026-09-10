/**
 * Route handler for a model-directed text send to a channel chat.
 *
 * POST /v1/channels/send: deliver text to a chat or person on a channel
 * through the channel's transport, recorded after acknowledgement. The
 * messaging tool's channel branch runs the same function in-process; this
 * route is the door for the CLI and scripts, so the two doors share one
 * seam and one record.
 */

import { z } from "zod";

import { CHANNEL_IDS } from "../../channels/types.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  ChannelNotAddressableError,
  ChannelSendFailedError,
  sendChannelText,
} from "../channel-send.js";
import { BadGatewayError, BadRequestError } from "./errors.js";
import { parseBody } from "./parse-body.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const ProactiveTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("chat"),
    chatId: z.string().min(1).describe("Chat id in the channel's own id space"),
    threadId: z
      .string()
      .min(1)
      .optional()
      .describe("Thread within the chat, in the channel's own id space"),
  }),
  z.object({
    kind: z.literal("person"),
    userId: z
      .string()
      .min(1)
      .describe("Person to reach in their DM, in the channel's own id space"),
  }),
]);

const ChannelSendRequestSchema = z.object({
  channel: z.enum(CHANNEL_IDS).describe("Channel to send on"),
  target: ProactiveTargetSchema,
  text: z.string().min(1).describe("Text to send"),
  renderRichly: z
    .boolean()
    .optional()
    .describe("Ask the channel for its rich rendering, where it has one"),
});

const ChannelSendResponseSchema = z.object({
  channel: z.enum(CHANNEL_IDS),
  chatId: z.string(),
  threadId: z.string().optional(),
  messageIds: z.array(z.string()),
  lastMessageId: z.string(),
  recordedIn: z.string().optional(),
});

async function handleChannelSend({ body }: RouteHandlerArgs) {
  const request = parseBody(ChannelSendRequestSchema, body);
  try {
    return await sendChannelText(request);
  } catch (e) {
    if (e instanceof ChannelNotAddressableError) {
      throw new BadRequestError(e.message);
    }
    if (e instanceof ChannelSendFailedError) {
      throw new BadGatewayError(e.message);
    }
    throw e;
  }
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "channels_send_post",
    endpoint: "channels/send",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Send text to a channel chat",
    description:
      "Deliver text to a chat or person on a channel through the channel's transport, recorded after the channel acknowledges it.",
    tags: ["channels"],
    handler: handleChannelSend,
    requestBody: ChannelSendRequestSchema,
    responseBody: ChannelSendResponseSchema,
  },
];
