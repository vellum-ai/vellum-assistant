import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ConversationSurfaceSnapshot } from "../daemon/conversation-surface-snapshots.js";
import type { TrustContext } from "../daemon/trust-context-types.js";

let getMessagesImpl: (conversationId: string) => Array<{
  id: string;
  conversationId: string;
  role: string;
  content: unknown;
  createdAt: number;
  metadata: string | null;
}> = () => [];

let conversationImpl:
  | {
      surfaceState: Map<
        string,
        { surfaceType: string; data: Record<string, unknown> }
      >;
      currentTurnSurfaces: Array<{
        surfaceId: string;
        surfaceType: string;
        data: Record<string, unknown>;
        completed?: boolean;
        completionSummary?: string;
      }>;
      getTurnOrRestingTrust: () => TrustContext | undefined;
    }
  | undefined;

const realCrud = await import("../persistence/conversation-crud.js");
mock.module("../persistence/conversation-crud.js", () => ({
  ...realCrud,
  getMessages: (conversationId: string) => getMessagesImpl(conversationId),
}));

const realRegistry = await import("../daemon/conversation-registry.js");
mock.module("../daemon/conversation-registry.js", () => ({
  ...realRegistry,
  findConversationOrSubagent: () => conversationImpl,
}));

const { listConversationSurfaceSnapshots } =
  await import("../daemon/conversation-surface-snapshots.js");

const CONVERSATION_ID = "conv-xyz";

const GUARDIAN_TRUST: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

const CONTACT_TRUST: TrustContext = {
  sourceChannel: "slack",
  trustClass: "trusted_contact",
};

function makeConversation(opts?: {
  trust?: TrustContext | undefined;
  surfaceState?: Map<
    string,
    { surfaceType: string; data: Record<string, unknown> }
  >;
  currentTurnSurfaces?: Array<{
    surfaceId: string;
    surfaceType: string;
    data: Record<string, unknown>;
    completed?: boolean;
    completionSummary?: string;
  }>;
}): NonNullable<typeof conversationImpl> {
  return {
    surfaceState: opts?.surfaceState ?? new Map(),
    currentTurnSurfaces: opts?.currentTurnSurfaces ?? [],
    getTurnOrRestingTrust: () =>
      Object.prototype.hasOwnProperty.call(opts ?? {}, "trust")
        ? opts?.trust
        : GUARDIAN_TRUST,
  };
}

function seedRows(
  rows: Array<{ id: string; content: unknown[]; metadata?: string }>,
): void {
  getMessagesImpl = () =>
    rows.map((row) => ({
      id: row.id,
      conversationId: CONVERSATION_ID,
      role: "assistant",
      content: row.content,
      createdAt: 0,
      metadata: row.metadata ?? null,
    }));
}

function taskProgressData(
  title: string,
  steps: Array<{ label: string; status: string }>,
): Record<string, unknown> {
  return {
    template: "task_progress",
    templateData: { title, steps },
  };
}

describe("listConversationSurfaceSnapshots", () => {
  beforeEach(() => {
    getMessagesImpl = () => [];
    conversationImpl = makeConversation();
  });

  test("fails closed when no conversation is loaded", () => {
    conversationImpl = undefined;
    seedRows([
      {
        id: "msg-1",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surf_abc",
            surfaceType: "card",
            data: taskProgressData("Hidden", [
              { label: "One", status: "pending" },
            ]),
          },
        ],
      },
    ]);

    expect(listConversationSurfaceSnapshots(CONVERSATION_ID)).toEqual([]);
  });

  test("fails closed when turn-or-resting trust is missing", () => {
    conversationImpl = makeConversation({ trust: undefined });
    seedRows([
      {
        id: "msg-1",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surf_abc",
            surfaceType: "card",
            data: taskProgressData("Hidden", [
              { label: "One", status: "pending" },
            ]),
          },
        ],
      },
    ]);

    expect(listConversationSurfaceSnapshots(CONVERSATION_ID)).toEqual([]);
  });

  test("live state wins over stale persisted data for the same surface ID", () => {
    const liveData = taskProgressData("Live title", [
      { label: "Compare the last incident", status: "in_progress" },
    ]);
    seedRows([
      {
        id: "msg-1",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surf_abc",
            surfaceType: "card",
            data: taskProgressData("Stale title", [
              { label: "Pull error logs", status: "pending" },
            ]),
          },
        ],
      },
    ]);
    conversationImpl = makeConversation({
      surfaceState: new Map([
        ["surf_abc", { surfaceType: "card", data: liveData }],
      ]),
    });

    expect(listConversationSurfaceSnapshots(CONVERSATION_ID)).toEqual([
      {
        surfaceId: "surf_abc",
        surfaceType: "card",
        data: liveData,
        completed: false,
      },
    ]);
  });

  test("a current-turn surface is visible before final message persistence", () => {
    const data = taskProgressData("Researching the billing outage", [
      { label: "Pull error logs", status: "in_progress" },
    ]);
    seedRows([]);
    conversationImpl = makeConversation({
      surfaceState: new Map([["surf_abc", { surfaceType: "card", data }]]),
      currentTurnSurfaces: [
        { surfaceId: "surf_abc", surfaceType: "card", data },
      ],
    });

    expect(listConversationSurfaceSnapshots(CONVERSATION_ID)).toEqual([
      {
        surfaceId: "surf_abc",
        surfaceType: "card",
        data,
        completed: false,
      },
    ]);
  });

  test("an ui_update inside the debounce window is visible", () => {
    const persisted = taskProgressData("Researching the billing outage", [
      { label: "Pull error logs", status: "in_progress" },
    ]);
    const live = taskProgressData("Researching the billing outage", [
      { label: "Pull error logs", status: "completed" },
      { label: "Compare the last incident", status: "in_progress" },
    ]);
    seedRows([
      {
        id: "msg-1",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surf_abc",
            surfaceType: "card",
            data: persisted,
          },
        ],
      },
    ]);
    conversationImpl = makeConversation({
      surfaceState: new Map([
        ["surf_abc", { surfaceType: "card", data: live }],
      ]),
    });

    expect(listConversationSurfaceSnapshots(CONVERSATION_ID)[0]?.data).toEqual(
      live,
    );
  });

  test("unbounded persisted fallback finds an active card behind the compaction boundary", () => {
    const data = taskProgressData("Researching the billing outage", [
      { label: "Propose a fix", status: "pending" },
    ]);
    seedRows([
      {
        id: "msg-compacted",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surf_abc",
            surfaceType: "card",
            data,
          },
        ],
      },
    ]);
    conversationImpl = makeConversation({
      surfaceState: new Map(),
    });

    expect(listConversationSurfaceSnapshots(CONVERSATION_ID)).toEqual([
      {
        surfaceId: "surf_abc",
        surfaceType: "card",
        data,
        completed: false,
      },
    ]);
  });

  test("completion is represented so completed surfaces can be excluded", () => {
    seedRows([
      {
        id: "msg-1",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surf_done",
            surfaceType: "card",
            completed: true,
            completionSummary: "All steps finished",
            data: taskProgressData("Done", [
              { label: "Propose a fix", status: "completed" },
            ]),
          },
        ],
      },
    ]);

    const snapshots = listConversationSurfaceSnapshots(CONVERSATION_ID);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.completed).toBe(true);
    expect(snapshots[0]?.completionSummary).toBe("All steps finished");
  });

  test("current-turn completion overlays a not-yet-persisted surface", () => {
    const data = taskProgressData("Done", [
      { label: "Propose a fix", status: "completed" },
    ]);
    seedRows([]);
    conversationImpl = makeConversation({
      surfaceState: new Map([["surf_abc", { surfaceType: "card", data }]]),
      currentTurnSurfaces: [
        {
          surfaceId: "surf_abc",
          surfaceType: "card",
          data,
          completed: true,
          completionSummary: "Closed this turn",
        },
      ],
    });

    expect(listConversationSurfaceSnapshots(CONVERSATION_ID)[0]).toEqual({
      surfaceId: "surf_abc",
      surfaceType: "card",
      data,
      completed: true,
      completionSummary: "Closed this turn",
    });
  });

  test("dismissed surfaces are absent", () => {
    seedRows([
      {
        id: "msg-1",
        content: [{ type: "text", text: "the card was dismissed" }],
      },
    ]);
    conversationImpl = makeConversation({
      surfaceState: new Map(),
      currentTurnSurfaces: [],
    });

    expect(listConversationSurfaceSnapshots(CONVERSATION_ID)).toEqual([]);
  });

  test("duplicate IDs resolve deterministically with newest data and first-seen order", () => {
    const older = taskProgressData("Older", [
      { label: "Pull error logs", status: "pending" },
    ]);
    const newer = taskProgressData("Newer", [
      { label: "Pull error logs", status: "completed" },
    ]);
    const other = taskProgressData("Other card", [
      { label: "Propose a fix", status: "pending" },
    ]);
    seedRows([
      {
        id: "msg-1",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surf_abc",
            surfaceType: "card",
            data: older,
          },
        ],
      },
      {
        id: "msg-2",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surf_other",
            surfaceType: "card",
            data: other,
          },
        ],
      },
      {
        id: "msg-3",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surf_abc",
            surfaceType: "card",
            data: newer,
          },
        ],
      },
    ]);

    expect(
      listConversationSurfaceSnapshots(CONVERSATION_ID).map(
        (snapshot: ConversationSurfaceSnapshot) => ({
          surfaceId: snapshot.surfaceId,
          title: (snapshot.data.templateData as { title?: string }).title,
        }),
      ),
    ).toEqual([
      { surfaceId: "surf_abc", title: "Newer" },
      { surfaceId: "surf_other", title: "Other card" },
    ]);
  });

  test("hides guardian-provenance rows from an untrusted loaded conversation", () => {
    seedRows([
      {
        id: "msg-guardian",
        metadata: JSON.stringify({ provenanceTrustClass: "guardian" }),
        content: [
          {
            type: "ui_surface",
            surfaceId: "surf_guardian",
            surfaceType: "card",
            data: taskProgressData("Guardian only", [
              { label: "Secret", status: "pending" },
            ]),
          },
        ],
      },
      {
        id: "msg-contact",
        metadata: JSON.stringify({ provenanceTrustClass: "trusted_contact" }),
        content: [
          {
            type: "ui_surface",
            surfaceId: "surf_contact",
            surfaceType: "card",
            data: taskProgressData("Visible", [
              { label: "Public", status: "pending" },
            ]),
          },
        ],
      },
    ]);
    conversationImpl = makeConversation({ trust: CONTACT_TRUST });

    expect(
      listConversationSurfaceSnapshots(CONVERSATION_ID).map(
        (snapshot) => snapshot.surfaceId,
      ),
    ).toEqual(["surf_contact"]);
  });

  test("does not leak a guardian-only live card to an untrusted view", () => {
    seedRows([]);
    conversationImpl = makeConversation({
      trust: CONTACT_TRUST,
      surfaceState: new Map([
        [
          "surf_guardian",
          {
            surfaceType: "card",
            data: taskProgressData("Guardian only", [
              { label: "Secret", status: "pending" },
            ]),
          },
        ],
      ]),
    });

    expect(listConversationSurfaceSnapshots(CONVERSATION_ID)).toEqual([]);
  });

  test("serves a contact-provenance row to an untrusted requester", () => {
    const data = taskProgressData("Visible", [
      { label: "Public", status: "pending" },
    ]);
    seedRows([
      {
        id: "msg-contact",
        metadata: JSON.stringify({ provenanceTrustClass: "trusted_contact" }),
        content: [
          {
            type: "ui_surface",
            surfaceId: "surf_contact",
            surfaceType: "card",
            data,
          },
        ],
      },
    ]);
    conversationImpl = makeConversation({ trust: CONTACT_TRUST });

    expect(listConversationSurfaceSnapshots(CONVERSATION_ID)[0]?.data).toEqual(
      data,
    );
  });

  test("returned snapshots do not expose daemon-owned mutable objects", () => {
    const liveData = taskProgressData("Live", [
      { label: "Pull error logs", status: "pending" },
    ]);
    seedRows([
      {
        id: "msg-1",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surf_abc",
            surfaceType: "card",
            data: taskProgressData("Persisted", [
              { label: "Pull error logs", status: "pending" },
            ]),
          },
        ],
      },
    ]);
    const surfaceState = new Map([
      ["surf_abc", { surfaceType: "card", data: liveData }],
    ]);
    conversationImpl = makeConversation({ surfaceState });

    const [snapshot] = listConversationSurfaceSnapshots(CONVERSATION_ID);
    expect(snapshot).toBeDefined();
    expect(snapshot?.data).not.toBe(liveData);
    snapshot!.data.title = "mutated";
    (snapshot!.data.templateData as { title?: string }).title = "mutated";
    expect(surfaceState.get("surf_abc")?.data).toEqual(liveData);
  });

  test("does not memoize persisted scan results into live surfaceState", () => {
    const surfaceState = new Map<
      string,
      { surfaceType: string; data: Record<string, unknown> }
    >();
    seedRows([
      {
        id: "msg-1",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surf_abc",
            surfaceType: "card",
            data: taskProgressData("Behind compaction", [
              { label: "Propose a fix", status: "pending" },
            ]),
          },
        ],
      },
    ]);
    conversationImpl = makeConversation({ surfaceState });

    expect(listConversationSurfaceSnapshots(CONVERSATION_ID)).toHaveLength(1);
    expect(surfaceState.size).toBe(0);
  });
});
