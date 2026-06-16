import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the daemon workspace-file API + sentry so the helper is exercised
// without any network or real error reporting.
let fileContent: string | null = "- **Name:** _(not yet chosen)_\n- **Role:** Founder\n";
let getOk = true;
const workspaceFileGetMock = mock(async () => ({
  data: fileContent === null ? undefined : { content: fileContent, isBinary: false },
  response: { ok: getOk, status: getOk ? 200 : 404 },
}));
const workspaceWritePostMock = mock(async () => ({
  data: undefined,
  response: { ok: true, status: 200 },
}));
mock.module("@/generated/daemon/sdk.gen", () => ({
  workspaceFileGet: workspaceFileGetMock,
  workspaceWritePost: workspaceWritePostMock,
}));
mock.module("@/lib/sentry/capture-error", () => ({ captureError: () => {} }));

const { persistCastAssistantName } = await import(
  "@/domains/onboarding/cast/persist-assistant-name"
);

function lastWrittenContent(): string {
  const call = workspaceWritePostMock.mock.calls.at(-1)![0] as {
    body: { content: string };
  };
  return call.body.content;
}

beforeEach(() => {
  fileContent = "- **Name:** _(not yet chosen)_\n- **Role:** Founder\n";
  getOk = true;
  workspaceFileGetMock.mockClear();
  workspaceWritePostMock.mockClear();
});

afterEach(() => {});

describe("persistCastAssistantName", () => {
  test("rewrites only the Name line, preserving the rest", async () => {
    await persistCastAssistantName("asst-1", "Pixel");
    expect(workspaceWritePostMock).toHaveBeenCalledTimes(1);
    const written = lastWrittenContent();
    expect(written).toContain("- **Name:** Pixel");
    expect(written).toContain("- **Role:** Founder");
    expect(written).not.toContain("_(not yet chosen)_");
  });

  test("preserves the existing label casing", async () => {
    fileContent = "- **Name:** Old\n";
    await persistCastAssistantName("asst-1", "Pixel");
    expect(lastWrittenContent()).toBe("- **Name:** Pixel\n");
  });

  test("trims the name and skips a blank name", async () => {
    await persistCastAssistantName("asst-1", "   ");
    expect(workspaceFileGetMock).not.toHaveBeenCalled();
    expect(workspaceWritePostMock).not.toHaveBeenCalled();
  });

  test("no-ops when IDENTITY.md has no Name line (doesn't corrupt unknown format)", async () => {
    fileContent = "# Identity\n\nsome freeform text\n";
    await persistCastAssistantName("asst-1", "Pixel");
    expect(workspaceWritePostMock).not.toHaveBeenCalled();
  });

  test("no-ops when the file is missing", async () => {
    fileContent = null;
    getOk = false;
    await persistCastAssistantName("asst-1", "Pixel");
    expect(workspaceWritePostMock).not.toHaveBeenCalled();
  });
});
