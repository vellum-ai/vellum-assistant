import { join } from "node:path";
import { afterEach, expect, mock, spyOn, test } from "bun:test";

import { setOverridesForTesting } from "../__tests__/feature-flag-test-helpers.js";
import { getConfig } from "../config/loader.js";
import { getBundledSkillsDir } from "../config/skills.js";
import { parseToolManifestFile } from "../skills/tool-manifest.js";
import { computeSkillVersionHash } from "../skills/version-hash.js";
import { skillLoadTool } from "../tools/skills/load.js";
import { createSkillTool } from "../tools/skills/skill-tool-factory.js";
import type { ToolContext } from "../tools/types.js";
import { DesktopControl, desktopControl } from "./desktop-control.js";
import { isAssistantDesktopEnabled } from "./desktop-feature.js";
import type { DesktopSessionManager } from "./desktop-session-manager.js";

const context: ToolContext = {
  conversationId: "conversation-123",
  sourceActorPrincipalId: "user-123",
  trustClass: "guardian",
  workingDir: process.env.VELLUM_WORKSPACE_DIR!,
};

afterEach(() => {
  setOverridesForTesting({});
});

test("the desktop skill is unavailable while the desktop feature is off", async () => {
  setOverridesForTesting({});
  const result = await skillLoadTool.execute(
    { skill: "assistant-desktop" },
    context,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("disabled by feature flag");
});

test("the desktop flag enables skill loading and local control without a host client", async () => {
  setOverridesForTesting({ "assistant-desktop": true });
  const loaded = await skillLoadTool.execute(
    { skill: "assistant-desktop" },
    context,
  );
  expect(loaded.isError).toBe(false);
  expect(loaded.content).toContain("desktop_control");

  const input = {
    observe: mock(async () => ({
      png: Buffer.from("screenshot"),
      width: 1440,
      height: 900,
    })),
    perform: mock(async () => {}),
    releaseInput: mock(async () => {}),
    setViewerInput: mock(async () => {}),
  };
  const started = mock(async () => {});
  const control = new DesktopControl({
    enabled: () => isAssistantDesktopEnabled(getConfig(), true),
    ready: () => true,
    manager: () =>
      ({
        acquireAutomationSlot: () => ({ ok: true }),
        releaseAutomationSlot: () => {},
        ensureDesktopRunning: started,
      }) as unknown as DesktopSessionManager,
    input,
    notify: async () => {},
  });
  const execute = spyOn(desktopControl, "execute").mockImplementation(
    (args, ctx) => control.execute(args, ctx),
  );
  try {
    const skillDir = join(getBundledSkillsDir(), "assistant-desktop");
    const manifest = parseToolManifestFile(join(skillDir, "TOOLS.json"));
    const tool = createSkillTool(
      manifest.tools[0]!,
      skillDir,
      computeSkillVersionHash(skillDir),
      true,
    );
    const observed = await tool.execute({ action: "observe" }, context);
    expect(observed.isError).toBe(false);
    expect(observed.contentBlocks?.[0]?.type).toBe("image");
    expect(started).toHaveBeenCalledTimes(1);
    const observationId = /observation_id: ([a-f0-9-]+)/.exec(
      observed.content,
    )?.[1];
    expect(observationId).toBeDefined();

    const clicked = await tool.execute(
      { action: "click", x: 100, y: 50, observation_id: observationId },
      context,
    );
    expect(clicked.isError).toBe(false);
    expect(input.perform).toHaveBeenCalledTimes(1);

    setOverridesForTesting({ "assistant-desktop": false });
    const denied = await tool.execute({ action: "observe" }, context);
    expect(denied.isError).toBe(true);
    expect(input.observe).toHaveBeenCalledTimes(2);
  } finally {
    await control.takeControl();
    execute.mockRestore();
  }
});
