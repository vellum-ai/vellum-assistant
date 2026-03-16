import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getRootDir } from "../../credential-reader.js";
import { getLogger } from "../../logger.js";

const log = getLogger("privacy-config");

/** Serializes config writes so concurrent PATCH requests don't race. */
let configWriteChain: Promise<void> = Promise.resolve();

function getConfigPath(): string {
  return join(getRootDir(), "workspace", "config.json");
}

function readConfigFile():
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; detail: string } {
  const cfgPath = getConfigPath();
  if (!existsSync(cfgPath)) {
    return { ok: true, data: {} };
  }
  try {
    const raw = readFileSync(cfgPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, detail: "Config file is not a JSON object" };
    }
    return { ok: true, data: parsed };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

function writeConfigFileAtomic(data: Record<string, unknown>): void {
  const cfgPath = getConfigPath();
  const dir = dirname(cfgPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = join(dir, `.config.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, cfgPath);
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

    const { collectUsageData } = body as { collectUsageData?: unknown };
    if (typeof collectUsageData !== "boolean") {
      return Response.json(
        { error: '"collectUsageData" must be a boolean' },
        { status: 400 },
      );
    }

    const writeResult = new Promise<Response>((resolve) => {
      configWriteChain = configWriteChain.then(() => {
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
          config.collectUsageData = collectUsageData;
          writeConfigFileAtomic(config);

          log.info({ collectUsageData }, "Privacy config updated");
          resolve(Response.json({ collectUsageData }));
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
