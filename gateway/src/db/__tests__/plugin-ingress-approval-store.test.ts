import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../__tests__/test-preload.js";
import { getGatewayDb, initGatewayDb, resetGatewayDb } from "../connection.js";
import {
  approvePluginIngress,
  getPluginIngressApproval,
  listPluginIngressApprovals,
  revokePluginIngressApproval,
} from "../plugin-ingress-approval-store.js";
import { pluginIngressApprovals } from "../schema.js";

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  getGatewayDb().delete(pluginIngressApprovals).run();
});

afterEach(() => {
  resetGatewayDb();
});

describe("plugin ingress approval store", () => {
  it("starts empty", () => {
    expect(listPluginIngressApprovals()).toEqual([]);
    expect(getPluginIngressApproval("meeting-bot")).toBeUndefined();
  });

  it("records an approval and reads it back", () => {
    approvePluginIngress({ plugin: "meeting-bot", digest: "abc123" });

    const row = getPluginIngressApproval("meeting-bot");
    expect(row?.digest).toBe("abc123");
    expect(row?.approvedBy).toBeNull();
    expect(typeof row?.approvedAt).toBe("number");
  });

  it("records the granting principal when one is given", () => {
    approvePluginIngress({
      plugin: "meeting-bot",
      digest: "abc123",
      approvedBy: "guardian-1",
    });
    expect(getPluginIngressApproval("meeting-bot")?.approvedBy).toBe(
      "guardian-1",
    );
  });

  it("replaces rather than accumulating, so a plugin has one approval", () => {
    // Approving a new declaration must revoke the previous grant in the
    // same write, or the old routes would stay live alongside the new.
    approvePluginIngress({ plugin: "meeting-bot", digest: "old" });
    approvePluginIngress({ plugin: "meeting-bot", digest: "new" });

    expect(listPluginIngressApprovals()).toHaveLength(1);
    expect(getPluginIngressApproval("meeting-bot")?.digest).toBe("new");
  });

  it("keeps approvals for different plugins independent", () => {
    approvePluginIngress({ plugin: "meeting-bot", digest: "shared" });
    approvePluginIngress({ plugin: "other", digest: "shared" });

    expect(listPluginIngressApprovals()).toHaveLength(2);
    revokePluginIngressApproval("meeting-bot");
    expect(listPluginIngressApprovals().map((a) => a.plugin)).toEqual([
      "other",
    ]);
  });

  it("reports whether a revoke removed anything", () => {
    approvePluginIngress({ plugin: "meeting-bot", digest: "abc123" });
    expect(revokePluginIngressApproval("meeting-bot")).toBe(true);
    expect(revokePluginIngressApproval("meeting-bot")).toBe(false);
    expect(getPluginIngressApproval("meeting-bot")).toBeUndefined();
  });
});
