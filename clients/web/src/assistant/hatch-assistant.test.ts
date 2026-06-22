/**
 * Unit test for `hatchAssistant`'s `mode` passthrough.
 *
 * The developer "Hatch New Assistant" button needs `mode=create` to actually
 * provision an additional assistant; omitting it lets the platform default to
 * `ensure` and hand back the existing one. This pins that the query param is
 * sent only when a mode is given (so the auto-hatch callers stay on `ensure`).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

type HatchCall = { body?: unknown; query?: unknown; throwOnError?: boolean };

const hatchCreateMock = mock(async (_opts: HatchCall) => ({
  data: { id: "ast-new" },
  error: undefined,
  response: { ok: true, status: 201 },
}));

// `api.ts` imports many names from sdk.gen at module load, and bun throws on
// any missing named export — so stub them all. Only assistantsHatchCreate is
// exercised here.
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
  assistantsHatchCreate: hatchCreateMock,
  assistantsList: noop,
  assistantsRestartDetailCreate: noop,
  assistantsRetireDetailDestroy: noop,
  assistantsRetireDestroy: noop,
  assistantsRetrieve: noop,
}));

const { hatchAssistant } = await import("./api");

beforeEach(() => {
  hatchCreateMock.mockClear();
});

describe("hatchAssistant", () => {
  test("omits the mode query by default (ensure semantics for auto-hatch)", async () => {
    await hatchAssistant();
    expect(hatchCreateMock.mock.calls[0]?.[0].query).toBeUndefined();
  });

  test("sends mode=create to provision an additional assistant", async () => {
    const result = await hatchAssistant(undefined, "create");
    expect(hatchCreateMock.mock.calls[0]?.[0].query).toEqual({ mode: "create" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(201);
      expect(result.data.id).toBe("ast-new");
    }
  });
});
