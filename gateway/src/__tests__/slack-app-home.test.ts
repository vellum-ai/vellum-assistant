import { describe, test, expect } from "bun:test";
import { buildAppHomeView, type AppHomeContext } from "../slack/app-home.js";

describe("buildAppHomeView", () => {
  test("returns a home-type view", () => {
    const ctx: AppHomeContext = { connected: true };
    const view = buildAppHomeView(ctx);
    expect(view.type).toBe("home");
  });

  test("includes header block with 'Vellum Assistant'", () => {
    const ctx: AppHomeContext = { connected: true };
    const view = buildAppHomeView(ctx);
    const header = view.blocks.find((b) => b.type === "header");
    expect(header).toBeDefined();
    expect(header!.type === "header" && header!.text.text).toBe(
      "Vellum Assistant",
    );
  });

  test("shows green status when connected", () => {
    const ctx: AppHomeContext = { connected: true };
    const view = buildAppHomeView(ctx);
    const statusBlock = view.blocks.find(
      (b) =>
        b.type === "section" &&
        b.text.type === "mrkdwn" &&
        b.text.text.includes("Status"),
    );
    expect(statusBlock).toBeDefined();
    if (statusBlock && statusBlock.type === "section") {
      expect(statusBlock.text.text).toContain(":large_green_circle:");
      expect(statusBlock.text.text).toContain("Connected");
    }
  });

  test("shows red status when disconnected", () => {
    const ctx: AppHomeContext = { connected: false };
    const view = buildAppHomeView(ctx);
    const statusBlock = view.blocks.find(
      (b) =>
        b.type === "section" &&
        b.text.type === "mrkdwn" &&
        b.text.text.includes("Status"),
    );
    expect(statusBlock).toBeDefined();
    if (statusBlock && statusBlock.type === "section") {
      expect(statusBlock.text.text).toContain(":red_circle:");
      expect(statusBlock.text.text).toContain("Disconnected");
    }
  });

  test("includes workspace name when provided", () => {
    const ctx: AppHomeContext = {
      connected: true,
      workspaceName: "My Workspace",
    };
    const view = buildAppHomeView(ctx);
    const connectionBlock = view.blocks.find(
      (b) =>
        b.type === "section" &&
        b.text.type === "mrkdwn" &&
        b.text.text.includes("Connection Info"),
    );
    expect(connectionBlock).toBeDefined();
    if (connectionBlock && connectionBlock.type === "section") {
      expect(connectionBlock.text.text).toContain("My Workspace");
    }
  });

  test("includes bot username when provided", () => {
    const ctx: AppHomeContext = {
      connected: true,
      botUsername: "vellum-bot",
    };
    const view = buildAppHomeView(ctx);
    const connectionBlock = view.blocks.find(
      (b) =>
        b.type === "section" &&
        b.text.type === "mrkdwn" &&
        b.text.text.includes("Connection Info"),
    );
    expect(connectionBlock).toBeDefined();
    if (connectionBlock && connectionBlock.type === "section") {
      expect(connectionBlock.text.text).toContain("@vellum-bot");
    }
  });

  test("omits workspace line when not provided", () => {
    const ctx: AppHomeContext = { connected: true };
    const view = buildAppHomeView(ctx);
    const connectionBlock = view.blocks.find(
      (b) =>
        b.type === "section" &&
        b.text.type === "mrkdwn" &&
        b.text.text.includes("Connection Info"),
    );
    expect(connectionBlock).toBeDefined();
    if (connectionBlock && connectionBlock.type === "section") {
      expect(connectionBlock.text.text).not.toContain("Workspace:");
    }
  });

  test("omits bot line when not provided", () => {
    const ctx: AppHomeContext = { connected: true };
    const view = buildAppHomeView(ctx);
    const connectionBlock = view.blocks.find(
      (b) =>
        b.type === "section" &&
        b.text.type === "mrkdwn" &&
        b.text.text.includes("Connection Info"),
    );
    expect(connectionBlock).toBeDefined();
    if (connectionBlock && connectionBlock.type === "section") {
      expect(connectionBlock.text.text).not.toContain("Bot:");
    }
  });

  test("includes capabilities section", () => {
    const ctx: AppHomeContext = { connected: true };
    const view = buildAppHomeView(ctx);
    const capBlock = view.blocks.find(
      (b) =>
        b.type === "section" &&
        b.text.type === "mrkdwn" &&
        b.text.text.includes("Capabilities"),
    );
    expect(capBlock).toBeDefined();
    if (capBlock && capBlock.type === "section") {
      expect(capBlock.text.text).toContain("Mention me");
      expect(capBlock.text.text).toContain("direct message");
      expect(capBlock.text.text).toContain("threads");
    }
  });

  test("includes dividers between sections", () => {
    const ctx: AppHomeContext = { connected: true };
    const view = buildAppHomeView(ctx);
    const dividers = view.blocks.filter((b) => b.type === "divider");
    expect(dividers.length).toBeGreaterThanOrEqual(2);
  });

  test("all blocks have valid types", () => {
    const ctx: AppHomeContext = {
      connected: true,
      botUsername: "bot",
      workspaceName: "ws",
    };
    const view = buildAppHomeView(ctx);
    const validTypes = new Set(["header", "section", "divider", "actions"]);
    for (const block of view.blocks) {
      expect(validTypes.has(block.type)).toBe(true);
    }
  });
});
