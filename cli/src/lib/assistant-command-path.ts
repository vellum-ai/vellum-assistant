/**
 * Classify a resolved assistant entrypoint and locate the `assistant` command
 * that ships beside it.
 *
 * The daemon is started from one of two layouts: a developer's repo checkout,
 * or an installed npm package (`<install>/node_modules/@vellumai/assistant/
 * src/index.ts` — what the desktop app runs). The two need different daemon
 * environments, and only the installed layout has an `assistant` bin to put on
 * PATH.
 */

import { existsSync } from "node:fs";
import { join, sep } from "node:path";

const NODE_MODULES_SEGMENT = `${sep}node_modules${sep}`;

/**
 * Whether `entry` is a developer's repo checkout rather than an installed
 * package. Drives `VELLUM_DEV`: an npm-installed runtime is a production run
 * even though it is started "from source", and flagging it as dev suppresses
 * telemetry and skips the `assistant` command install.
 */
export function isRepoCheckoutEntry(entry: string): boolean {
  return !entry.includes(NODE_MODULES_SEGMENT);
}

/**
 * The `node_modules/.bin` directory holding the `assistant` command that goes
 * with `entry`, as a PATH fragment (empty when there is none).
 *
 * Prepending this is what makes `assistant …` resolve for commands the agent
 * runs: the daemon's own PATH is inherited from a GUI app launch, so it
 * carries none of the install's bin directories. Searches innermost
 * `node_modules` outward, since a nested install shadows a hoisted one.
 */
export function assistantCommandPathDirs(entry: string): string[] {
  let index = entry.lastIndexOf(NODE_MODULES_SEGMENT);

  while (index !== -1) {
    const nodeModulesDir = entry.slice(
      0,
      index + NODE_MODULES_SEGMENT.length - 1,
    );
    const binDir = join(nodeModulesDir, ".bin");
    if (existsSync(join(binDir, "assistant"))) {
      return [binDir];
    }
    index = entry.lastIndexOf(NODE_MODULES_SEGMENT, index - 1);
  }

  return [];
}
