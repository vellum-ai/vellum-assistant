import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import "../__tests__/test-preload.js";
import { getGatewayDb, initGatewayDb, resetGatewayDb } from "./connection.js";
import { recordDenialReplyIfAllowed } from "./denial-reply-rate-limiter.js";
import { channelDenialReplyLog } from "./schema.js";

beforeAll(async () => {
  resetGatewayDb();
  await initGatewayDb();
});

afterAll(() => {
  resetGatewayDb();
});

beforeEach(() => {
  getGatewayDb().delete(channelDenialReplyLog).run();
});

describe("recordDenialReplyIfAllowed", () => {
  it("allows one email reply per sender per window", () => {
    expect(recordDenialReplyIfAllowed("email", "stranger@example.com")).toBe(
      true,
    );
    expect(recordDenialReplyIfAllowed("email", "stranger@example.com")).toBe(
      false,
    );
  });

  it("counts each email sender separately", () => {
    expect(recordDenialReplyIfAllowed("email", "alice@example.com")).toBe(true);
    expect(recordDenialReplyIfAllowed("email", "bob@example.com")).toBe(true);
  });

  it("keeps the default per-sender limit on other channels", () => {
    const allowed = Array.from({ length: 4 }, () =>
      recordDenialReplyIfAllowed("telegram", "user-123"),
    );
    expect(allowed).toEqual([true, true, true, false]);
  });
});
