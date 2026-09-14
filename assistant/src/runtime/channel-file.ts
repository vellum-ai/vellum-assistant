/**
 * Fetch a file a channel's bot can see, by the channel's own file id,
 * through the channel's transport.
 *
 * The one implementation behind the CLI door (`channels file`, over
 * `GET /v1/channels/:channel/files/:fileId`). The transport resolves the
 * file's URL and the bot credential itself, so the caller names an id and
 * never a URL: the credential reaches the platform's file host only from
 * code the adapter owns, and the raw request door keeps its allowlist at
 * the API host.
 */

import { CHANNEL_IDS, type ChannelId } from "../channels/types.js";
import type { DownloadedChannelFile } from "../messaging/providers/channel-transport.js";
import {
  channelsWithFileDownload,
  getTransportForChannel,
} from "../messaging/providers/index.js";

/**
 * The most a fetched file may weigh, matching the runtime's upload ceiling
 * (`MAX_UPLOAD_BYTES` in routes/attachment-routes.ts) and the gateway's
 * default ingest cap, so a file the assistant can receive is one it can
 * fetch.
 */
export const CHANNEL_FILE_MAX_BYTES = 100 * 1024 * 1024;

/** The channel has no transport that can fetch a file by id. */
export class ChannelFileNotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelFileNotSupportedError";
  }
}

export interface DownloadChannelFileParams {
  channel: string;
  fileId: string;
  account?: string;
}

export interface DownloadedChannelFileResult extends DownloadedChannelFile {
  channel: ChannelId;
  fileId: string;
}

export async function downloadChannelFile(
  params: DownloadChannelFileParams,
): Promise<DownloadedChannelFileResult> {
  const channel = CHANNEL_IDS.find((id) => id === params.channel);
  const transport = getTransportForChannel(channel);
  if (!channel || !transport?.downloadFile) {
    throw new ChannelFileNotSupportedError(
      `Channel "${params.channel}" cannot fetch a file by id. Channels that can: ${channelsWithFileDownload().join(", ")}.`,
    );
  }
  const file = await transport.downloadFile(
    { fileId: params.fileId, account: params.account },
    { maxBytes: CHANNEL_FILE_MAX_BYTES },
  );
  return { channel, fileId: params.fileId, ...file };
}
