import { browserManager } from "../../../../tools/browser/browser-manager.js";
import { normalizeBrowserMode } from "../../../../tools/browser/browser-mode.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  // Validate browser_mode: only auto/local are supported for downloads.
  const modeResult = normalizeBrowserMode(input.browser_mode);
  if ("error" in modeResult) {
    return { content: `Error: ${modeResult.error}`, isError: true };
  }
  const { mode } = modeResult;
  if (mode !== "auto" && mode !== "local") {
    return {
      content:
        `Error: browser_wait_for_download does not support browser_mode "${mode}". ` +
        `File downloads require the local Playwright backend. ` +
        `Use browser_mode "auto" or "local" instead.`,
      isError: true,
    };
  }

  const timeout =
    typeof input.timeout === "number"
      ? Math.min(Math.max(input.timeout, 1000), 120_000)
      : 30_000;

  try {
    const download = await browserManager.waitForDownload(
      context.conversationId,
      timeout,
    );
    return {
      content: JSON.stringify({
        filename: download.filename,
        path: download.path,
      }),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}
