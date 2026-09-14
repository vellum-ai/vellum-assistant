/**
 * Fetch a Slack file by id as the bot, the way inbound ingest does: resolve
 * the file's own download URL with `files.info`, then fetch it with the bot
 * token from inside the process. The caller names an id and never a URL, so
 * no credential-bearing URL is composed anywhere a model can see it.
 */

import {
  ChannelFileUnavailableError,
  type DownloadedChannelFile,
} from "../channel-transport.js";
import { withSlackBotToken } from "./adapter.js";
import { getSlackFileInfo } from "./api.js";
import { downloadSlackFile } from "./download.js";

export async function downloadSlackFileById(
  fileId: string,
  account: string | undefined,
  maxBytes: number,
): Promise<DownloadedChannelFile> {
  const file = await getSlackFileInfo(fileId);
  if (!file) {
    throw new ChannelFileUnavailableError(
      `Slack returned no file for id ${fileId}`,
    );
  }
  const downloaded = await withSlackBotToken(account, (token) =>
    downloadSlackFile(
      {
        id: file.id,
        name: file.name,
        mimetype: file.mimetype,
        urlPrivateDownload: file.url_private_download,
        urlPrivate: file.url_private,
      },
      token,
      { maxBytes },
    ),
  );
  if (downloaded === null) {
    throw new ChannelFileUnavailableError(
      `Slack bot credential is not configured, or file ${fileId} has no download URL`,
    );
  }
  return {
    filename: downloaded.filename,
    mimeType: downloaded.mimeType,
    data: downloaded.data,
    size: Buffer.byteLength(downloaded.data, "base64"),
  };
}
