/**
 * Fetch a Slack file by id as the bot, the way inbound ingest does: resolve
 * the file's own download URL with `files.info`, then fetch it with the bot
 * token from inside the process. The caller names an id and never a URL, so
 * no credential-bearing URL is composed anywhere a model can see it.
 */

import {
  ChannelFileTooLargeError,
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
  // One token for both calls, so the metadata and the bytes come from the
  // same account when several workspaces are connected.
  const downloaded = await withSlackBotToken(account, async (token) => {
    const file = await getSlackFileInfo(fileId, token);
    if (!file) {
      throw new ChannelFileUnavailableError(`Slack knows no file ${fileId}`);
    }
    const bytes = await downloadSlackFile(
      {
        id: file.id,
        name: file.name,
        mimetype: file.mimetype,
        urlPrivateDownload: file.url_private_download,
        urlPrivate: file.url_private,
      },
      token,
      { maxBytes },
    );
    if (bytes === null) {
      throw new ChannelFileUnavailableError(
        `Slack file ${fileId} has no download URL`,
      );
    }
    return bytes;
  }).catch((error: unknown) => {
    if (
      error instanceof ChannelFileTooLargeError ||
      error instanceof ChannelFileUnavailableError
    ) {
      throw error;
    }
    // A Slack refusal (unknown id, missing scope, a failed fetch) is the
    // channel not handing the file back, which the route reports as
    // unavailable rather than as an internal failure.
    throw new ChannelFileUnavailableError(
      `Slack did not hand back file ${fileId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  // The helper answers null only when no bot credential is configured; the
  // downloader's own null, a file with no URL, is turned into an error above.
  if (downloaded === null) {
    throw new ChannelFileUnavailableError(
      "Slack has no bot credential configured",
    );
  }
  return {
    filename: downloaded.filename,
    mimeType: downloaded.mimeType,
    data: downloaded.data,
    size: Buffer.byteLength(downloaded.data, "base64"),
  };
}
