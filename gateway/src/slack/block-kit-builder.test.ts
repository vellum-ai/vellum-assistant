import { describe, it, expect } from "bun:test";
import {
  BlockKitBuilder,
  button,
  approvalPrompt,
  approvalResolved,
  permissionRequest,
  progressIndicator,
  errorMessage,
  type SectionBlock,
  type ActionsBlock,
  type ContextBlock,
  type DividerBlock,
  type HeaderBlock,
  type ButtonElement,
} from "./block-kit-builder.js";

// ---------------------------------------------------------------------------
// button()
// ---------------------------------------------------------------------------

describe("button", () => {
  it("creates a minimal button element", () => {
    const btn = button({ actionId: "click_me", text: "Click" });
    expect(btn).toEqual({
      type: "button",
      text: { type: "plain_text", text: "Click", emoji: true },
      action_id: "click_me",
    });
  });

  it("includes value when provided", () => {
    const btn = button({ actionId: "a1", text: "Go", value: "v1" });
    expect(btn.value).toBe("v1");
  });

  it("includes style when provided", () => {
    const primary = button({
      actionId: "a1",
      text: "OK",
      style: "primary",
    });
    expect(primary.style).toBe("primary");

    const danger = button({
      actionId: "a2",
      text: "Delete",
      style: "danger",
    });
    expect(danger.style).toBe("danger");
  });

  it("omits value and style when not provided", () => {
    const btn = button({ actionId: "a1", text: "Hi" });
    expect("value" in btn).toBe(false);
    expect("style" in btn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BlockKitBuilder — individual block types
// ---------------------------------------------------------------------------

describe("BlockKitBuilder", () => {
  it("builds a section block with mrkdwn text", () => {
    const blocks = new BlockKitBuilder().section("Hello *world*").toBlocks();
    expect(blocks).toHaveLength(1);

    const section = blocks[0] as SectionBlock;
    expect(section.type).toBe("section");
    expect(section.text).toEqual({ type: "mrkdwn", text: "Hello *world*" });
  });

  it("builds a divider block", () => {
    const blocks = new BlockKitBuilder().divider().toBlocks();
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as DividerBlock).type).toBe("divider");
  });

  it("builds an actions block with buttons", () => {
    const btn = button({ actionId: "act_1", text: "Press" });
    const blocks = new BlockKitBuilder().actions([btn]).toBlocks();
    expect(blocks).toHaveLength(1);

    const actions = blocks[0] as ActionsBlock;
    expect(actions.type).toBe("actions");
    expect(actions.elements).toHaveLength(1);
    expect(actions.elements[0].action_id).toBe("act_1");
  });

  it("builds a context block with text elements", () => {
    const blocks = new BlockKitBuilder()
      .context([{ type: "mrkdwn", text: "hint" }])
      .toBlocks();
    expect(blocks).toHaveLength(1);

    const ctx = blocks[0] as ContextBlock;
    expect(ctx.type).toBe("context");
    expect(ctx.elements).toHaveLength(1);
    expect(ctx.elements[0]).toEqual({ type: "mrkdwn", text: "hint" });
  });

  it("builds a context block via contextMrkdwn shorthand", () => {
    const blocks = new BlockKitBuilder().contextMrkdwn("note").toBlocks();
    const ctx = blocks[0] as ContextBlock;
    expect(ctx.elements).toEqual([{ type: "mrkdwn", text: "note" }]);
  });

  it("builds a header block with plain text", () => {
    const blocks = new BlockKitBuilder().header("Title").toBlocks();
    expect(blocks).toHaveLength(1);

    const header = blocks[0] as HeaderBlock;
    expect(header.type).toBe("header");
    expect(header.text).toEqual({
      type: "plain_text",
      text: "Title",
      emoji: true,
    });
  });

  it("chains multiple block types", () => {
    const blocks = BlockKitBuilder.header("Status Update")
      .section("Things are going well.")
      .divider()
      .actions([button({ actionId: "ack", text: "Acknowledge" })])
      .contextMrkdwn("Sent by Vellum")
      .toBlocks();

    expect(blocks).toHaveLength(5);
    expect(blocks.map((b) => b.type)).toEqual([
      "header",
      "section",
      "divider",
      "actions",
      "context",
    ]);
  });

  it("static section() starts a new builder", () => {
    const blocks = BlockKitBuilder.section("hi").toBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("section");
  });

  it("static divider() starts a new builder", () => {
    const blocks = BlockKitBuilder.divider().toBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("divider");
  });
});

// ---------------------------------------------------------------------------
// Helper: approvalPrompt
// ---------------------------------------------------------------------------

describe("approvalPrompt", () => {
  it("produces section + actions blocks", () => {
    const blocks = approvalPrompt({
      message: "Allow file access?",
      requestId: "req-1",
      actions: [
        { id: "approve_once", label: "Approve" },
        { id: "reject", label: "Reject" },
      ],
    });

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("section");
    expect((blocks[0] as SectionBlock).text.text).toBe("Allow file access?");

    const actions = blocks[1] as ActionsBlock;
    expect(actions.type).toBe("actions");
    expect(actions.elements).toHaveLength(2);
  });

  it("encodes requestId and actionId into action_id", () => {
    const blocks = approvalPrompt({
      message: "ok?",
      requestId: "r42",
      actions: [{ id: "go", label: "Go" }],
    });

    const btn = (blocks[1] as ActionsBlock).elements[0] as ButtonElement;
    expect(btn.action_id).toBe("apr:r42:go");
    expect(btn.value).toBe("apr:r42:go");
  });

  it("applies style to buttons", () => {
    const blocks = approvalPrompt({
      message: "ok?",
      requestId: "r1",
      actions: [
        { id: "yes", label: "Yes", style: "primary" },
        { id: "no", label: "No", style: "danger" },
      ],
    });

    const elements = (blocks[1] as ActionsBlock).elements;
    expect(elements[0].style).toBe("primary");
    expect(elements[1].style).toBe("danger");
  });
});

// ---------------------------------------------------------------------------
// Helper: permissionRequest
// ---------------------------------------------------------------------------

describe("permissionRequest", () => {
  it("produces approve (primary) and reject (danger) buttons", () => {
    const blocks = permissionRequest({
      message: "Run shell command?",
      requestId: "req-99",
    });

    expect(blocks).toHaveLength(2);
    const actions = blocks[1] as ActionsBlock;
    expect(actions.elements).toHaveLength(2);

    expect(actions.elements[0].action_id).toBe("apr:req-99:approve_once");
    expect(actions.elements[0].style).toBe("primary");

    expect(actions.elements[1].action_id).toBe("apr:req-99:reject");
    expect(actions.elements[1].style).toBe("danger");
  });
});

// ---------------------------------------------------------------------------
// Helper: progressIndicator
// ---------------------------------------------------------------------------

describe("progressIndicator", () => {
  it("produces section + context blocks", () => {
    const blocks = progressIndicator({
      title: "Deploying...",
      status: "Step 2 of 5",
    });

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("section");
    expect((blocks[0] as SectionBlock).text.text).toBe("Deploying...");

    const ctx = blocks[1] as ContextBlock;
    expect(ctx.type).toBe("context");
    expect(ctx.elements[0]).toEqual({ type: "mrkdwn", text: "Step 2 of 5" });
  });
});

// ---------------------------------------------------------------------------
// Helper: errorMessage
// ---------------------------------------------------------------------------

describe("errorMessage", () => {
  it("produces a section with warning prefix", () => {
    const blocks = errorMessage({ message: "Something broke" });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("section");
    expect((blocks[0] as SectionBlock).text.text).toBe(
      ":warning: Something broke",
    );
  });

  it("appends context when detail is provided", () => {
    const blocks = errorMessage({
      message: "Timeout",
      detail: "Request took >30s",
    });

    expect(blocks).toHaveLength(2);
    expect(blocks[1].type).toBe("context");
    expect((blocks[1] as ContextBlock).elements[0]).toEqual({
      type: "mrkdwn",
      text: "Request took >30s",
    });
  });

  it("omits context when detail is not provided", () => {
    const blocks = errorMessage({ message: "Oops" });
    expect(blocks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Helper: approvalResolved
// ---------------------------------------------------------------------------

describe("approvalResolved", () => {
  it("produces section + context blocks with approved status", () => {
    const blocks = approvalResolved({
      message: "Allow file access?",
      decision: "approved",
    });

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("section");
    expect((blocks[0] as SectionBlock).text.text).toBe("Allow file access?");

    const ctx = blocks[1] as ContextBlock;
    expect(ctx.type).toBe("context");
    expect(ctx.elements[0]).toEqual({
      type: "mrkdwn",
      text: "\u2713 Approved",
    });
  });

  it("produces section + context blocks with denied status", () => {
    const blocks = approvalResolved({
      message: "Run shell command?",
      decision: "denied",
    });

    expect(blocks).toHaveLength(2);
    const ctx = blocks[1] as ContextBlock;
    expect(ctx.elements[0]).toEqual({
      type: "mrkdwn",
      text: "\u2717 Denied",
    });
  });

  it("does not include an actions block", () => {
    const blocks = approvalResolved({
      message: "test",
      decision: "approved",
    });

    const hasActions = blocks.some((b) => b.type === "actions");
    expect(hasActions).toBe(false);
  });
});
