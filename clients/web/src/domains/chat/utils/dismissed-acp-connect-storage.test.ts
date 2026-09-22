import { afterEach, describe, expect, test } from "bun:test";

import {
  addDismissedAcpConnectId,
  loadDismissedAcpConnectIds,
  removeDismissedAcpConnectId,
} from "@/domains/chat/utils/dismissed-acp-connect-storage";
import { clearUserScopedOverrides } from "@/utils/typed-storage";

const KEY = "vellum:dismissed-acp-connect";

afterEach(() => {
  localStorage.clear();
  clearUserScopedOverrides();
});

describe("dismissed ACP Connect storage", () => {
  test("reads empty before anything is stored", () => {
    expect(loadDismissedAcpConnectIds().size).toBe(0);
  });

  test("a written id survives a later load (reload)", () => {
    addDismissedAcpConnectId("toolu-acp-1");

    expect(loadDismissedAcpConnectIds().has("toolu-acp-1")).toBe(true);
    expect(localStorage.getItem(KEY)).toContain("toolu-acp-1");
  });

  test("adding the same id twice does not duplicate it", () => {
    addDismissedAcpConnectId("toolu-acp-1");
    addDismissedAcpConnectId("toolu-acp-1");

    expect([...loadDismissedAcpConnectIds()]).toEqual(["toolu-acp-1"]);
  });

  test("removing an id forgets only that spawn", () => {
    addDismissedAcpConnectId("toolu-acp-1");
    addDismissedAcpConnectId("toolu-acp-2");
    removeDismissedAcpConnectId("toolu-acp-1");

    expect(loadDismissedAcpConnectIds().has("toolu-acp-1")).toBe(false);
    expect(loadDismissedAcpConnectIds().has("toolu-acp-2")).toBe(true);
  });

  test("a later spawn id is stored beside an earlier one", () => {
    addDismissedAcpConnectId("toolu-acp-1");
    addDismissedAcpConnectId("toolu-acp-2");

    expect(loadDismissedAcpConnectIds().has("toolu-acp-1")).toBe(true);
    expect(loadDismissedAcpConnectIds().has("toolu-acp-2")).toBe(true);
  });

  test("a malformed payload reads as empty rather than throwing", () => {
    localStorage.setItem(KEY, "{not json");

    expect(loadDismissedAcpConnectIds().size).toBe(0);
  });

  test("writes under a user-scoped key so logout clears it", () => {
    addDismissedAcpConnectId("toolu-acp-1");

    expect(localStorage.getItem(KEY)).toContain("toolu-acp-1");
  });
});
