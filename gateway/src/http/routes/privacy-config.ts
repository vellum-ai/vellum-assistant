import { getLogger } from "../../logger.js";
import {
  enqueueConfigWrite,
  readConfigFile,
  writeConfigFileAtomic,
} from "./config-file-utils.js";

const log = getLogger("privacy-config");

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
