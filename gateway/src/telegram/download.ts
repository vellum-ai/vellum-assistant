import { fileTypeFromBuffer } from "file-type";
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
  fileId: string,
  hint?: { fileName?: string; mimeType?: string },
  opts?: { credentials?: CredentialCache; configFile?: ConfigFileCache },
): Promise<DownloadedFile> {
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
