/**
 * Handle model get/set signals delivered via signal files from the CLI.
 *
 * The built-in CLI writes JSON to `signals/model` instead of making
 * HTTP GET/PUT requests to `/v1/model`. The daemon's ConfigWatcher
 * detects the file change and invokes {@link handleModelSignal}, which
 * reads the payload, performs the get or set, and writes
 * `signals/model.result` so the CLI receives feedback.
 *
 * Because the set handler needs access to the daemon's session map and
 * config reload machinery, the daemon registers a callback at startup
 * via {@link registerModelCallback}.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ModelInfo } from "../daemon/handlers/config-model.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("signal:model");

// ── Daemon callback registry ─────────────────────────────────────────

type ModelGetCallback = () => Promise<ModelInfo>;
type ModelSetCallback = (modelId: string) => Promise<ModelInfo>;

let _getModelInfo: ModelGetCallback | null = null;
let _setModel: ModelSetCallback | null = null;

/**
 * Register the model callbacks. Called once by the daemon server at
 * startup so the signal handler can reach config and session state.
 */
export function registerModelCallback(cbs: {
  get: ModelGetCallback;
  set: ModelSetCallback;
}): void {
  _getModelInfo = cbs.get;
  _setModel = cbs.set;
}

// ── Signal handler ───────────────────────────────────────────────────

/**
 * Read the `signals/model` file and perform the requested model
 * operation (get or set). Writes `signals/model.result` with the
 * outcome so the CLI can display feedback. Called by ConfigWatcher
 * when the signal file is written.
 */
export async function handleModelSignal(): Promise<void> {
  const resultPath = join(getWorkspaceDir(), "signals", "model.result");

  const writeResult = (
    data:
      | { ok: true; model: string; provider: string; requestId: string }
      | { ok: false; error: string; requestId: string | null },
  ): void => {
    try {
      writeFileSync(resultPath, JSON.stringify(data));
    } catch {
      // Best-effort — filesystem may be broken.
    }
  };

  let parsedRequestId: string | undefined;

  try {
    const content = readFileSync(
      join(getWorkspaceDir(), "signals", "model"),
      "utf-8",
    );
    const parsed = JSON.parse(content) as {
      action?: string;
      modelId?: string;
      requestId?: string;
    };
    const { action, modelId, requestId } = parsed;
    parsedRequestId = requestId;

    if (!requestId || typeof requestId !== "string") {
      log.warn("Model signal missing requestId");
      writeResult({ ok: false, error: "Missing requestId", requestId: null });
      return;
    }

    if (!action || (action !== "get" && action !== "set")) {
      log.warn({ action }, "Model signal has invalid action");
      writeResult({ ok: false, error: "Invalid action", requestId });
      return;
    }

    if (action === "set") {
      if (!modelId || typeof modelId !== "string") {
        log.warn("Model set signal missing modelId");
        writeResult({ ok: false, error: "Missing modelId", requestId });
        return;
      }

      if (!_setModel) {
        log.warn("Model set callback not registered; daemon may not be ready");
        writeResult({ ok: false, error: "Assistant not ready", requestId });
        return;
      }

      const info = await _setModel(modelId);
      log.info(
        { model: info.model, provider: info.provider },
        "Model set via signal file",
      );
      writeResult({
        ok: true,
        model: info.model,
        provider: info.provider,
        requestId,
      });
    } else {
      if (!_getModelInfo) {
        log.warn("Model get callback not registered; daemon may not be ready");
        writeResult({ ok: false, error: "Assistant not ready", requestId });
        return;
      }

      const info = await _getModelInfo();
      log.info(
        { model: info.model, provider: info.provider },
        "Model info retrieved via signal file",
      );
      writeResult({
        ok: true,
        model: info.model,
        provider: info.provider,
        requestId,
      });
    }
  } catch (err) {
    log.error({ err }, "Failed to handle model signal");
    writeResult({
      ok: false,
      error: "Internal error",
      requestId: parsedRequestId ?? null,
    });
  }
}
