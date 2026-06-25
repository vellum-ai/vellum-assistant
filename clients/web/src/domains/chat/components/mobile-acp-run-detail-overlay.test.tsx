/**
 * Tests for `MobileAcpRunDetailOverlay` — the mobile full-screen host for the
 * ACP run detail panel.
 *
 * Runs under happy-dom. The lazily-loaded `AcpRunDetailPanel` transitively pulls
 * in the generated daemon SDK (via `ToolDetailBody`), so stub every endpoint
 * before importing, then import dynamically so the mock registers first.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const sdkStub = async () => ({ data: undefined });
const realSdkPath = new URL(
  "../../../generated/daemon/sdk.gen.ts",
  import.meta.url,
).pathname;
const sdkSource = await Bun.file(realSdkPath).text();
const exportNames = [...sdkSource.matchAll(/^export const (\w+)/gm)].map(
  (m) => m[1]!,
);
const sdkMock = Object.fromEntries(exportNames.map((n) => [n, sdkStub]));
mock.module("@/generated/daemon/sdk.gen", () => sdkMock);

const { MobileAcpRunDetailOverlay } = await import(
  "@/domains/chat/components/mobile-acp-run-detail-overlay"
);
import type { AcpRunEntry } from "@/domains/chat/acp-run-store";

const noop = () => {};

function makeEntry(overrides: Partial<AcpRunEntry> = {}): AcpRunEntry {
  return {
    acpSessionId: "acp-1",
    agent: "claude",
    parentConversationId: "conv-1",
    task: "Research the thing",
    status: "running",
    startedAt: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalCost: 0,
    events: [],
    ...overrides,
  };
}

afterEach(cleanup);
afterAll(() => mock.restore());

describe("MobileAcpRunDetailOverlay", () => {
  test("renders nothing when entry is null", () => {
    const { container } = render(
      <MobileAcpRunDetailOverlay entry={null} onClose={noop} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("renders the panel when given an entry", async () => {
    render(<MobileAcpRunDetailOverlay entry={makeEntry()} onClose={noop} />);
    expect(await screen.findByText("claude")).toBeDefined();
  });

  test("close button fires onClose", async () => {
    let closed = 0;
    render(
      <MobileAcpRunDetailOverlay
        entry={makeEntry()}
        onClose={() => {
          closed += 1;
        }}
      />,
    );
    fireEvent.click(await screen.findByLabelText("Close run detail"));
    expect(closed).toBe(1);
  });

  test("Stop button stays hidden (onStop intentionally unwired)", async () => {
    render(<MobileAcpRunDetailOverlay entry={makeEntry()} onClose={noop} />);
    await screen.findByText("claude");
    expect(screen.queryByLabelText("Stop run")).toBeNull();
  });
});
