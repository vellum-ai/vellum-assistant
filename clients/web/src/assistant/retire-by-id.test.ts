/**
 * `retireAssistantById` forwards an optional successor to the platform so the
 * retiring assistant's managed OAuth connections move rather than being
 * revoked with it.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

type RetireCall = {
  path: { id: string };
  query?: { successor_assistant_id?: string };
};

const retireDetail = mock(async (_opts: RetireCall) => ({
  data: undefined,
  error: undefined,
  response: { ok: true, status: 204 },
}));
const noop = mock(async () => ({
  data: undefined,
  error: undefined,
  response: { ok: true, status: 200 },
}));
mock.module("@/generated/api/sdk.gen", () => ({
  assistantsActivateCreate: noop,
  assistantsBackupsCreate: noop,
  assistantsBackupsRestoreCreate: noop,
  assistantsBackupsRetrieve: noop,
  assistantsHatchCreate: noop,
  assistantsList: noop,
  assistantsRestartDetailCreate: noop,
  assistantsRetireDetailDestroy: retireDetail,
  assistantsRetireDestroy: noop,
  assistantsRetrieve: noop,
}));

const { retireAssistantById } = await import("./api");

beforeEach(() => {
  retireDetail.mockClear();
});

describe("retireAssistantById", () => {
  test("names the successor in the retire query", async () => {
    // GIVEN a teleport target that should inherit the OAuth connections
    // WHEN retiring the source with it
    const result = await retireAssistantById("src", {
      successorAssistantId: "succ",
    });

    // THEN the platform delete carries it as successor_assistant_id
    expect(result.ok).toBe(true);
    expect(retireDetail.mock.calls[0]?.[0]).toMatchObject({
      path: { id: "src" },
      query: { successor_assistant_id: "succ" },
    });
  });

  test("sends no query without a successor", async () => {
    await retireAssistantById("src");

    expect(retireDetail.mock.calls[0]?.[0]?.query).toBeUndefined();
  });
});
