import { fileTypeFromBuffer } from "file-type";
import type { GatewayConfig } from "../config.js";
import type { CredentialCache } from "../credential-cache.js";
import { fetchImpl } from "../fetch.js";
import { callTelegramApi } from "./api.js";

interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface DownloadedFile {
  filename: string;
  mimeType: string;
  data: string; // base64-encoded
}

/**
 * Download a file from Telegram by its file_id.
 * Calls the getFile API to resolve the file path, then fetches the binary.
 */
export async function downloadTelegramFile(
  config: GatewayConfig,
  fileId: string,
  hint?: { fileName?: string; mimeType?: string },
  opts?: { credentials?: CredentialCache },
): Promise<DownloadedFile> {
  const file = await callTelegramApi<TelegramFile>(
    config,
    "getFile",
    { file_id: fileId },
    opts?.credentials ? { credentials: opts.credentials } : undefined,
  );

  if (!file.file_path) {
    throw new Error(`Telegram getFile returned no file_path for ${fileId}`);
  }

  const botToken = opts?.credentials
    ? await opts.credentials.get("credential:telegram:bot_token")
    : undefined;

  const downloadUrl = `${config.telegramApiBaseUrl}/file/bot${botToken}/${file.file_path}`;
  const response = await fetchImpl(downloadUrl, {
    signal: AbortSignal.timeout(config.telegramTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download Telegram file: ${response.status} ${response.statusText}`,
    );
  }

  const filename =
    hint?.fileName || file.file_path.split("/").pop() || `file_${fileId}`;

  const buffer = await response.arrayBuffer();
  const detected = await fileTypeFromBuffer(new Uint8Array(buffer));

  const mimeType =
    hint?.mimeType ||
    detected?.mime ||
    response.headers.get("Content-Type")?.split(";")[0].trim() ||
    "application/octet-stream";

  const data = Buffer.from(buffer).toString("base64");

  return { filename, mimeType, data };
}
