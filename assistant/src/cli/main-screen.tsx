import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { getWorkspaceDir } from "../util/platform.js";
import { getHttpBaseUrl } from "./http-client.js";

const LEFT_PANEL_WIDTH = 36;
const RIGHT_LINE_COUNT = 11;

export interface MainScreenLayout {
  height: number;
  statusLine: number;
  statusCol: number;
}

export function renderMainScreen(): MainScreenLayout {
  const httpUrl = getHttpBaseUrl();
  const workspace = getWorkspaceDir();
  const assistantId = workspace.split("/").pop() ?? "vellum";

  const require = createRequire(import.meta.url);
  const cliPkgPath = require.resolve("@vellumai/cli/package.json");
  const cliRoot = dirname(cliPkgPath);
  // Dynamic require to bypass NodeNext strict module resolution for the
  // CLI package which ships raw TypeScript with bundler-style imports.
  const { render } = require(
    join(cliRoot, "src", "components", "DefaultMainScreen.tsx"),
  ) as {
    render: (
      runtimeUrl: string,
      assistantId: string,
      species: string,
    ) => number;
  };

  const height = render(httpUrl, assistantId, "vellum");

  const statusCanvasLine = RIGHT_LINE_COUNT + 1;
  const statusCol = LEFT_PANEL_WIDTH + 1;

  return { height, statusLine: statusCanvasLine, statusCol };
}

export function updateStatusText(layout: MainScreenLayout, text: string): void {
  process.stdout.write(
    `\x1b7\x1b[${layout.statusLine};${layout.statusCol}H\x1b[K${text}\x1b8`,
  );
}

export function updateDaemonText(layout: MainScreenLayout, text: string): void {
  const daemonLine = layout.statusLine - 4;
  process.stdout.write(
    `\x1b7\x1b[${daemonLine};${layout.statusCol}H\x1b[K\x1b[35m${text}\x1b[0m\x1b8`,
  );
}
