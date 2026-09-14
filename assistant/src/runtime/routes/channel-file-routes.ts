/**
 * Route handler for fetching a file a channel's bot can see.
 *
 * GET /v1/channels/:channel/files/:fileId: the file's bytes, base64 in the
 * same envelope the authenticated-request route uses, fetched through the
 * channel's transport. The CLI runs the handler in-process so a large file
 * never crosses IPC; this route is the door for scripts.
 */

import { z } from "zod";

import { CHANNEL_IDS } from "../../channels/types.js";
import {
  ChannelFileTooLargeError,
  ChannelFileUnavailableError,
} from "../../messaging/providers/channel-transport.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  ChannelFileNotSupportedError,
  downloadChannelFile,
} from "../channel-file.js";
import {
  BadGatewayError,
  BadRequestError,
  PayloadTooLargeError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const ChannelFileResponseSchema = z.object({
  channel: z.enum(CHANNEL_IDS),
  fileId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative().describe("Byte length of the file"),
  body: z.string().describe("The file's bytes, base64"),
  bodyEncoding: z.literal("base64"),
});

export type ChannelFileResponse = z.infer<typeof ChannelFileResponseSchema>;

export async function handleChannelFile({
  pathParams = {},
  queryParams = {},
}: RouteHandlerArgs): Promise<ChannelFileResponse> {
  const channel = pathParams.channel;
  const fileId = pathParams.fileId;
  if (!channel || !fileId) {
    throw new BadRequestError("channel and fileId are required");
  }
  try {
    const file = await downloadChannelFile({
      channel,
      fileId,
      account: queryParams.account,
    });
    return {
      channel: file.channel,
      fileId: file.fileId,
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size,
      body: file.data,
      bodyEncoding: "base64" as const,
    };
  } catch (e) {
    if (e instanceof ChannelFileNotSupportedError) {
      throw new BadRequestError(e.message);
    }
    if (e instanceof ChannelFileTooLargeError) {
      throw new PayloadTooLargeError(e.message);
    }
    if (e instanceof ChannelFileUnavailableError) {
      throw new BadGatewayError(e.message);
    }
    throw e;
  }
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "channels_file_get",
    endpoint: "channels/:channel/files/:fileId",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Fetch a file a channel's bot can see",
    description:
      "Fetch a file by the channel's own file id through the channel's transport, as the assistant's bot. Bytes come back base64.",
    tags: ["channels"],
    handler: handleChannelFile,
    pathParams: [
      { name: "channel", description: "Channel id, e.g. slack" },
      {
        name: "fileId",
        description: "The file's id in the channel's own id space",
      },
    ],
    queryParams: [
      {
        name: "account",
        schema: { type: "string" },
        description:
          "The bot account to fetch as, for a channel connected to several",
      },
    ],
    responseBody: ChannelFileResponseSchema,
  },
];
