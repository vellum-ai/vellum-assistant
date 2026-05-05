import { beforeEach, describe, expect, test } from "bun:test";

import {
  _clearAllOAuthConnectStates,
  clearExpiredOAuthConnectStates,
  getOAuthConnectState,
  setOAuthConnectComplete,
  setOAuthConnectError,
  setOAuthConnectPending,
} from "../oauth-connect-state.js";

describe("oauth-connect-state", () => {
  beforeEach(() => {
    _clearAllOAuthConnectStates();
  });

  test("setOAuthConnectPending → getOAuthConnectState returns pending", () => {
    setOAuthConnectPending("state-1", "google");
    const result = getOAuthConnectState("state-1");
    expect(result).toMatchObject({ status: "pending", service: "google" });
  });

  test("setOAuthConnectComplete without accountInfo → returns complete", () => {
    setOAuthConnectComplete("state-1", "google");
    const result = getOAuthConnectState("state-1");
    expect(result).toMatchObject({ status: "complete", service: "google" });
  });

  test("setOAuthConnectComplete with accountInfo → returns complete with accountInfo", () => {
    setOAuthConnectComplete("state-1", "google", "user@example.com");
    const result = getOAuthConnectState("state-1");
    expect(result).toMatchObject({
      status: "complete",
      service: "google",
      accountInfo: "user@example.com",
    });
  });

  test("setOAuthConnectComplete with grantedScopes → returns complete with grantedScopes", () => {
    setOAuthConnectComplete("state-1", "google", "user@example.com", ["scope:read", "scope:write"]);
    const result = getOAuthConnectState("state-1");
    expect(result).toMatchObject({
      status: "complete",
      service: "google",
      accountInfo: "user@example.com",
      grantedScopes: ["scope:read", "scope:write"],
    });
  });

  test("setOAuthConnectError → returns error with message", () => {
    setOAuthConnectError("state-1", "google", "token exchange failed");
    const result = getOAuthConnectState("state-1");
    expect(result).toMatchObject({
      status: "error",
      service: "google",
      error: "token exchange failed",
    });
  });

  test("re-setting same state token overwrites previous", () => {
    setOAuthConnectPending("state-1", "google");
    setOAuthConnectComplete("state-1", "google", "user@example.com");
    const result = getOAuthConnectState("state-1");
    expect(result?.status).toBe("complete");
  });

  test("getOAuthConnectState returns null for unknown state", () => {
    expect(getOAuthConnectState("nonexistent")).toBeNull();
  });

  test("_clearAllOAuthConnectStates removes all entries", () => {
    setOAuthConnectPending("state-1", "google");
    setOAuthConnectPending("state-2", "github");
    _clearAllOAuthConnectStates();
    expect(getOAuthConnectState("state-1")).toBeNull();
    expect(getOAuthConnectState("state-2")).toBeNull();
  });

  test("clearExpiredOAuthConnectStates removes expired pending entries", () => {
    setOAuthConnectPending("state-1", "google");
    // Advance Date.now by 6 minutes past PENDING_TTL_MS (5 min)
    const originalNow = Date.now;
    Date.now = () => originalNow() + 6 * 60 * 1000;
    clearExpiredOAuthConnectStates();
    Date.now = originalNow;
    expect(getOAuthConnectState("state-1")).toBeNull();
  });

  test("clearExpiredOAuthConnectStates removes expired complete entries (past 60s grace)", () => {
    setOAuthConnectComplete("state-1", "google");
    const originalNow = Date.now;
    Date.now = () => originalNow() + 2 * 60 * 1000; // advance 2 minutes past 60s grace
    clearExpiredOAuthConnectStates();
    Date.now = originalNow;
    expect(getOAuthConnectState("state-1")).toBeNull();
  });

  test("clearExpiredOAuthConnectStates removes expired error entries (past 60s grace)", () => {
    setOAuthConnectError("state-1", "google", "token exchange failed");
    const originalNow = Date.now;
    Date.now = () => originalNow() + 2 * 60 * 1000; // advance 2 minutes past 60s grace
    clearExpiredOAuthConnectStates();
    Date.now = originalNow;
    expect(getOAuthConnectState("state-1")).toBeNull();
  });

  test("clearExpiredOAuthConnectStates does not remove non-expired pending entries", () => {
    setOAuthConnectPending("state-1", "google");
    clearExpiredOAuthConnectStates(); // called without advancing time
    expect(getOAuthConnectState("state-1")).not.toBeNull();
  });

  test("sweep-on-insert: setOAuthConnectPending purges expired entries before inserting new one", () => {
    // 1. Add an entry that will expire
    setOAuthConnectPending("expired-state", "google");

    // 2. Advance Date.now past the PENDING_TTL_MS (5 min)
    const originalNow = Date.now;
    Date.now = () => originalNow() + 6 * 60 * 1000;

    // 3. Insert a new entry — this should trigger clearExpiredOAuthConnectStates() internally
    setOAuthConnectPending("new-state", "github");

    // 4. Restore Date.now before assertions (getOAuthConnectState also calls clearExpiredOAuthConnectStates)
    Date.now = originalNow;

    // The expired entry must have been swept out during the insert
    // Use the map directly via getOAuthConnectState — expired-state is gone
    // We call _clearAllOAuthConnectStates in beforeEach so we know the map started empty.
    // After the insert the map should only contain "new-state".
    const expiredResult = getOAuthConnectState("expired-state");
    expect(expiredResult).toBeNull();

    const newResult = getOAuthConnectState("new-state");
    expect(newResult).toMatchObject({ status: "pending", service: "github" });
  });
});
