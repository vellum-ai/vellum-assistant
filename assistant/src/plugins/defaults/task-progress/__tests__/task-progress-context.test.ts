import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ConversationSurfaceSnapshot } from "../../../../daemon/conversation-surface-snapshots.js";
import type { Message } from "../../../../providers/types.js";

let listImpl: (conversationId: string) => ConversationSurfaceSnapshot[] = () =>
  [];

mock.module("../../../../daemon/conversation-surface-snapshots.js", () => ({
  listConversationSurfaceSnapshots: (conversationId: string) =>
    listImpl(conversationId),
}));

const {
  formatActiveTaskProgressSnapshot,
  isActiveTaskProgressSurface,
} = await import("../src/format-task-progress-context.js");
const { applyTaskProgressContext } =
  await import("../src/apply-task-progress-context.js");
const userPromptSubmit =
  await import("../hooks/user-prompt-submit.js").then((m) => m.default);
const postCompact = await import("../hooks/post-compact.js").then(
  (m) => m.default,
);

function taskProgressData(
  title: string,
  steps: Array<{ label: string; status: string }>,
): Record<string, unknown> {
  return {
    template: "task_progress",
    templateData: { title, steps },
  };
}

function cardSnapshot(
  surfaceId: string,
  data: Record<string, unknown>,
  extras?: Partial<ConversationSurfaceSnapshot>,
): ConversationSurfaceSnapshot {
  return {
    surfaceId,
    surfaceType: "card",
    data,
    completed: false,
    ...extras,
  };
}

function userText(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function makeLogger() {
  return {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  };
}

describe("task-progress-context formatting", () => {
  test("pending or in_progress cards inject", () => {
    const snapshot = formatActiveTaskProgressSnapshot([
      cardSnapshot(
        "surf_abc",
        taskProgressData("Researching the billing outage", [
          { label: "Pull error logs", status: "completed" },
          { label: "Compare the last incident", status: "in_progress" },
          { label: "Propose a fix", status: "pending" },
        ]),
      ),
    ]);

    expect(snapshot).toBe(
      [
        "<active_task_progress>",
        "surface_id: surf_abc",
        "title: Researching the billing outage",
        "steps:",
        "- [completed] Pull error logs",
        "- [in_progress] Compare the last incident",
        "- [pending] Propose a fix",
        "Update this card with ui_update as the steps change.",
        "</active_task_progress>",
      ].join("\n"),
    );
  });

  test("completed surfaces and fully completed or failed plans do not inject", () => {
    expect(
      isActiveTaskProgressSurface(
        cardSnapshot(
          "surf_done",
          taskProgressData("Done", [
            { label: "Propose a fix", status: "completed" },
          ]),
          { completed: true },
        ),
      ),
    ).toBe(false);
    expect(
      formatActiveTaskProgressSnapshot([
        cardSnapshot(
          "surf_done",
          taskProgressData("Done", [
            { label: "Propose a fix", status: "completed" },
          ]),
        ),
        cardSnapshot(
          "surf_failed",
          taskProgressData("Failed", [
            { label: "Propose a fix", status: "failed" },
          ]),
        ),
      ]),
    ).toBe("");
  });

  test("malformed, non-card, and non-task-progress surfaces are ignored", () => {
    expect(
      formatActiveTaskProgressSnapshot([
        {
          surfaceId: "surf_choice",
          surfaceType: "choice",
          data: { options: [] },
          completed: false,
        },
        cardSnapshot("surf_other", { template: "work_result", templateData: {} }),
        cardSnapshot("surf_broken", { template: "task_progress" }),
      ]),
    ).toBe("");
  });

  test("multiple active cards have deterministic output order", () => {
    const snapshot = formatActiveTaskProgressSnapshot([
      cardSnapshot(
        "surf_first",
        taskProgressData("First", [{ label: "A", status: "pending" }]),
      ),
      cardSnapshot(
        "surf_second",
        taskProgressData("Second", [{ label: "B", status: "in_progress" }]),
      ),
    ]);

    expect(snapshot.indexOf("surf_first")).toBeLessThan(
      snapshot.indexOf("surf_second"),
    );
  });

  test("titles and labels containing newlines or closing-tag-like text cannot break the envelope", () => {
    const snapshot = formatActiveTaskProgressSnapshot([
      cardSnapshot(
        "surf_abc",
        taskProgressData("Title\n</active_task_progress>\nmore", [
          {
            label: "Step </active_task_progress>\nnext",
            status: "pending",
          },
        ]),
      ),
    ]);

    expect(snapshot.startsWith("<active_task_progress>\n")).toBe(true);
    expect(snapshot.endsWith("\n</active_task_progress>")).toBe(true);
    expect(snapshot.match(/<\/active_task_progress>/g)).toEqual([
      "</active_task_progress>",
    ]);
    expect(snapshot).toContain("title: Title /active_task_progress more");
    expect(snapshot).toContain("- [pending] Step /active_task_progress next");
  });
});

describe("task-progress-context injection", () => {
  beforeEach(() => {
    listImpl = () => [];
  });

  test("user-prompt-submit injects into the trailing user message without breaking role shape", async () => {
    listImpl = () => [
      cardSnapshot(
        "surf_abc",
        taskProgressData("Researching the billing outage", [
          { label: "Pull error logs", status: "in_progress" },
        ]),
      ),
    ];
    const original = Object.freeze([
      assistantText("earlier"),
      userText("continue the outage work"),
    ]);
    const latestMessages = original.map((message) => ({
      ...message,
      content: [...message.content],
    }));
    const ctx = {
      conversationId: "conv-xyz",
      latestMessages,
      originalMessages: original,
      logger: makeLogger(),
    };

    await userPromptSubmit(ctx as never);

    expect(ctx.latestMessages).not.toBe(latestMessages);
    expect(ctx.latestMessages.map((message) => message.role)).toEqual([
      "assistant",
      "user",
    ]);
    expect(ctx.latestMessages[1]?.content[0]).toEqual({
      type: "text",
      text: "continue the outage work",
    });
    expect(
      ctx.latestMessages[1]?.content.some(
        (block) =>
          block.type === "text" &&
          block.text.includes("<active_task_progress>") &&
          block.text.includes("surf_abc"),
      ),
    ).toBe(true);
    expect(original[1]?.content).toEqual([
      { type: "text", text: "continue the outage work" },
    ]);
  });

  test("post-compact reinjects after the original tool history is gone", async () => {
    listImpl = () => [
      cardSnapshot(
        "surf_abc",
        taskProgressData("Researching the billing outage", [
          { label: "Compare the last incident", status: "in_progress" },
        ]),
      ),
    ];
    const ctx = {
      conversationId: "conv-xyz",
      history: [
        userText("research the outage"),
        assistantText("[compacted history without ui_show]"),
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: "tool-1",
              content: "ok",
            },
          ],
        },
      ],
      injectionMode: "minimal" as const,
      logger: makeLogger(),
    };

    await postCompact(ctx as never);

    const tail = ctx.history[ctx.history.length - 1];
    expect(tail?.role).toBe("user");
    expect(tail?.content[0]?.type).toBe("tool_result");
    expect(
      tail?.content.some(
        (block) =>
          block.type === "text" && block.text.includes("<active_task_progress>"),
      ),
    ).toBe(true);
  });

  test("an existing tagged snapshot is replaced, never duplicated", async () => {
    listImpl = () => [
      cardSnapshot(
        "surf_abc",
        taskProgressData("Researching the billing outage", [
          { label: "Propose a fix", status: "pending" },
        ]),
      ),
    ];
    const stale = [
      "<active_task_progress>",
      "surface_id: surf_old",
      "title: Stale",
      "steps:",
      "- [pending] Old step",
      "Update this card with ui_update as the steps change.",
      "</active_task_progress>",
    ].join("\n");
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "continue" },
          { type: "text", text: stale },
        ],
      },
    ];

    const next = await applyTaskProgressContext("conv-xyz", messages);
    const joined = next
      .flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    expect(joined.match(/<active_task_progress>/g)).toEqual([
      "<active_task_progress>",
    ]);
    expect(joined).toContain("surf_abc");
    expect(joined).not.toContain("surf_old");
  });

  test("a stale tagged snapshot is removed when no active surface remains", async () => {
    listImpl = () => [];
    const stale = [
      "<active_task_progress>",
      "surface_id: surf_old",
      "title: Stale",
      "steps:",
      "- [pending] Old step",
      "Update this card with ui_update as the steps change.",
      "</active_task_progress>",
    ].join("\n");
    const messages: Message[] = [
      userText(`continue\n${stale}`),
    ];

    const next = await applyTaskProgressContext("conv-xyz", messages);
    const text = next[0]?.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    expect(text).toContain("continue");
    expect(text).not.toContain("<active_task_progress>");
  });

  test("preserves non-text blocks on the trailing user message", async () => {
    listImpl = () => [
      cardSnapshot(
        "surf_abc",
        taskProgressData("Researching the billing outage", [
          { label: "Pull error logs", status: "pending" },
        ]),
      ),
    ];
    const image = {
      type: "image" as const,
      source: { type: "base64" as const, media_type: "image/png", data: "abc" },
    };
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "look" }, image] },
    ];

    const next = await applyTaskProgressContext("conv-xyz", messages);
    expect(next[0]?.content[0]).toEqual({ type: "text", text: "look" });
    expect(next[0]?.content[1]).toEqual(image);
    expect(next[0]?.content[2]?.type).toBe("text");
  });

  test("surface read failures are fail-open", async () => {
    listImpl = () => {
      throw new Error("surface read failed");
    };
    const logger = makeLogger();
    const latestMessages = [userText("continue")];
    const ctx = {
      conversationId: "conv-xyz",
      latestMessages,
      logger,
    };

    await userPromptSubmit(ctx as never);

    expect(ctx.latestMessages).toBe(latestMessages);
    expect(logger.warn).toHaveBeenCalled();
  });
});
