import {
  finalizeDownloadedAttachment,
  readLimitedAttachmentResponse,
} from "../attachments/download.js";
import type { DownloadedAttachment } from "../attachments/ingest.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import { fetchImpl } from "../fetch.js";
import { callTelegramApi } from "./api.js";

interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

/**
 * Download a file from Telegram by its file_id.
 * Calls the getFile API to resolve the file path, then fetches the binary.
 */
export async function downloadTelegramFile(
  fileId: string,
  maxBytes: number,
  hint?: { fileName?: string; mimeType?: string },
  opts?: { credentials?: CredentialCache; configFile?: ConfigFileCache },
): Promise<DownloadedAttachment> {
  const file = await callTelegramApi<TelegramFile>(
    "getFile",
    { file_id: fileId },
    opts?.credentials
      ? { credentials: opts.credentials, configFile: opts?.configFile }
      : undefined,
  );

  if (!file.file_path) {
    throw new Error(`Telegram getFile returned no file_path for ${fileId}`);
  }

  const botToken = opts?.credentials
    ? await opts.credentials.get(credentialKey("telegram", "bot_token"))
    : undefined;

  const apiBaseUrl =
    opts?.configFile?.getString("telegram", "apiBaseUrl") ??
    "https://api.telegram.org";
  const timeoutMs =
    opts?.configFile?.getNumber("telegram", "timeoutMs") ?? 15000;

  const downloadUrl = `${apiBaseUrl}/file/bot${botToken}/${file.file_path}`;
  const response = await fetchImpl(downloadUrl, {
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download Telegram file: ${response.status} ${response.statusText}`,
    );
  }

  return finalizeDownloadedAttachment(
    await readLimitedAttachmentResponse(response, maxBytes, fileId),
    {
      attachmentId: fileId,
      mimeTypeCandidatesBeforeDetection: [hint?.mimeType],
      responseContentType: response.headers.get("Content-Type"),
      filename: hint?.fileName || file.file_path.split("/").pop(),
      fallbackFilename: () => `file_${fileId}`,
    },
  );
}
