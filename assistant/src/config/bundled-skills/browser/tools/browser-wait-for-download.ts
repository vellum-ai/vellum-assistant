import { browserManager } from "../../../../tools/browser/browser-manager.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const timeout =
    typeof input.timeout === "number"
      ? Math.min(Math.max(input.timeout, 1000), 120_000)
      : 30_000;

  try {
    const download = await browserManager.waitForDownload(
      context.sessionId,
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
