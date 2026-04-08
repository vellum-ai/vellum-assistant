import { getLogger } from "../../logger.js";
import {
  enqueueConfigWrite,
  readConfigFile,
  writeConfigFileAtomic,
} from "./config-file-utils.js";

const log = getLogger("privacy-config");

// These defaults MUST match the daemon's Zod schema defaults. See
// `assistant/src/config/schema.ts` (collectUsageData, sendDiagnostics) and
// `assistant/src/config/schemas/memory-lifecycle.ts`
// (memory.cleanup.llmRequestLogRetentionMs). Keep them in sync.
const DEFAULT_COLLECT_USAGE_DATA = true;
const DEFAULT_SEND_DIAGNOSTICS = true;
const DEFAULT_LLM_REQUEST_LOG_RETENTION_MS = 1 * 24 * 60 * 60 * 1000;

export function createPrivacyConfigGetHandler() {
  return async (_req: Request): Promise<Response> => {
    const result = readConfigFile();
    if (!result.ok) {
      log.error(
        { detail: result.detail },
        "Failed to read config.json for privacy config GET",
      );
      return Response.json(
        { error: "Config file is malformed" },
        { status: 500 },
      );
    }

    const config = result.data;

    const rawCollectUsageData = (config as { collectUsageData?: unknown })
      .collectUsageData;
    const collectUsageData =
      typeof rawCollectUsageData === "boolean"
        ? rawCollectUsageData
        : DEFAULT_COLLECT_USAGE_DATA;

    const rawSendDiagnostics = (config as { sendDiagnostics?: unknown })
      .sendDiagnostics;
    const sendDiagnostics =
      typeof rawSendDiagnostics === "boolean"
        ? rawSendDiagnostics
        : DEFAULT_SEND_DIAGNOSTICS;

    // Extract nested memory.cleanup.llmRequestLogRetentionMs safely.
    const memory = (config as { memory?: unknown }).memory;
    const cleanup =
      memory && typeof memory === "object" && !Array.isArray(memory)
        ? (memory as { cleanup?: unknown }).cleanup
        : undefined;
    const rawRetention =
      cleanup && typeof cleanup === "object" && !Array.isArray(cleanup)
        ? (cleanup as { llmRequestLogRetentionMs?: unknown })
            .llmRequestLogRetentionMs
        : undefined;
    // Must be a non-negative integer. A value of 0 is valid (means
    // "never prune") and should be returned verbatim.
    const llmRequestLogRetentionMs =
      typeof rawRetention === "number" &&
      Number.isInteger(rawRetention) &&
      rawRetention >= 0
        ? rawRetention
        : DEFAULT_LLM_REQUEST_LOG_RETENTION_MS;

    return Response.json({
      collectUsageData,
      sendDiagnostics,
      llmRequestLogRetentionMs,
    });
  };
}

export function createPrivacyConfigPatchHandler() {
  return async (req: Request): Promise<Response> => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { error: "Request body must be valid JSON" },
        { status: 400 },
      );
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json(
        { error: "Request body must be a JSON object" },
        { status: 400 },
      );
    }

    const { collectUsageData, sendDiagnostics } = body as {
      collectUsageData?: unknown;
      sendDiagnostics?: unknown;
    };

    const hasCollectUsageData = "collectUsageData" in (body as object);
    const hasSendDiagnostics = "sendDiagnostics" in (body as object);

    if (!hasCollectUsageData && !hasSendDiagnostics) {
      return Response.json(
        {
          error:
            'At least one of "collectUsageData" or "sendDiagnostics" must be provided',
        },
        { status: 400 },
      );
    }

    if (hasCollectUsageData && typeof collectUsageData !== "boolean") {
      return Response.json(
        { error: '"collectUsageData" must be a boolean' },
        { status: 400 },
      );
    }

    if (hasSendDiagnostics && typeof sendDiagnostics !== "boolean") {
      return Response.json(
        { error: '"sendDiagnostics" must be a boolean' },
        { status: 400 },
      );
    }

    const writeResult = new Promise<Response>((resolve) => {
      enqueueConfigWrite(() => {
        try {
          const result = readConfigFile();
          if (!result.ok) {
            resolve(
              Response.json(
                { error: "Config file is malformed, cannot safely write" },
                { status: 500 },
              ),
            );
            return;
          }

          const config = result.data;
          if (hasCollectUsageData) {
            config.collectUsageData = collectUsageData;
          }
          if (hasSendDiagnostics) {
            config.sendDiagnostics = sendDiagnostics;
          }
          writeConfigFileAtomic(config);

          const responseData = {
            collectUsageData: config.collectUsageData,
            sendDiagnostics: config.sendDiagnostics,
          };
          log.info(responseData, "Privacy config updated");
          resolve(Response.json(responseData));
        } catch (err) {
          log.error({ err }, "Failed to update privacy config");
          resolve(
            Response.json({ error: "Internal server error" }, { status: 500 }),
          );
        }
      });
    });

    return writeResult;
  };
}
