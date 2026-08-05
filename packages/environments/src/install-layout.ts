/**
 * Reading the layout a Vellum runtime is installed in.
 *
 * The daemon is started either from a developer's repo checkout or from an
 * installed npm package (`<install>/node_modules/@vellumai/assistant/src/
 * index.ts`, which is what the desktop app runs). The CLI needs the layout to
 * decide whether a launch is a dev run and what to put on the daemon's PATH;
 * the daemon needs it to decide what to install as the `assistant` command.
 * Both ask the same two questions, so they ask them here.
 */

import { existsSync } from "node:fs";
import { join, sep } from "node:path";

const NODE_MODULES_SEGMENT = `${sep}node_modules${sep}`;

/**
 * Whether `path` sits in a developer's repo checkout rather than inside an
 * installed package.
 */
export function isRepoCheckoutPath(path: string): boolean {
  return !path.includes(NODE_MODULES_SEGMENT);
}

/**
 * The `assistant` command shipped with the install that contains `path`, or
 * null when there is none (a repo checkout, or an install whose dependency
 * graph omits the package declaring the bin).
 *
 * Searches innermost `node_modules` outward, since a nested install shadows a
 * hoisted one.
 */
export function findAssistantCommand(path: string): string | null {
  let index = path.lastIndexOf(NODE_MODULES_SEGMENT);

  while (index !== -1) {
    const nodeModulesDir = path.slice(
      0,
      index + NODE_MODULES_SEGMENT.length - 1,
    );
    const command = join(nodeModulesDir, ".bin", "assistant");
    if (existsSync(command)) {
      return command;
    }
    index = path.lastIndexOf(NODE_MODULES_SEGMENT, index - 1);
  }

  return null;
}
