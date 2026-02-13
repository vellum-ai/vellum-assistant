import { fileTypeFromBuffer } from "file-type";
import type { GatewayConfig } from "../config.js";
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
): Promise<DownloadedFile> {
  const file = await callTelegramApi<TelegramFile>(config, "getFile", {
    file_id: fileId,
  });

  if (!file.file_path) {
    throw new Error(`Telegram getFile returned no file_path for ${fileId}`);
  }

  const downloadUrl = `${config.telegramApiBaseUrl}/file/bot${config.telegramBotToken}/${file.file_path}`;
  const response = await fetch(downloadUrl);

  if (!response.ok) {
    throw new Error(
      `Failed to download Telegram file: ${response.status} ${response.statusText}`,
    );
  }

  const filename =
    hint?.fileName ||
    file.file_path.split("/").pop() ||
    `file_${fileId}`;

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
