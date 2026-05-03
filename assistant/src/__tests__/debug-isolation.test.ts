import { test, expect } from "bun:test";
import { runAssistantCommandFull } from "../cli/__tests__/run-assistant-command.js";

test("debug: stdout for wake --json with no server", async () => {
  const { stdout } = await runAssistantCommandFull(
    "conversations",
    "wake",
    "conv-nope",
    "--hint",
    "will fail",
    "--json",
  );
  process.stderr.write("DEBUG stdout: " + JSON.stringify(stdout) + "\n");
  expect(true).toBe(true);
});
