import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

import { computerUseObserveTool } from "../tools/computer-use/definitions.js";

test("window observation schema matches the skill manifest", () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL(
        "../config/bundled-skills/computer-use/TOOLS.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  expect(
    manifest.tools.find(
      (tool: { name: string }) => tool.name === "computer_use_observe",
    ).input_schema,
  ).toEqual(computerUseObserveTool.input_schema);
  expect(
    computerUseObserveTool.input_schema.properties.capture_window_id,
  ).toMatchObject({ type: "integer", minimum: 1, maximum: 4294967295 });
});
