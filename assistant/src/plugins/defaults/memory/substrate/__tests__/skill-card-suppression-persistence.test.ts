import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const realPluginApi = await import("@vellumai/plugin-api");
const realSkillStore = await import("../skill-store.js");

let mockActive = true;
const WINDOWS_CARD =
  '# Skill: windows-automation\nThe "Windows Automation" skill (windows-automation) is available. Automates native Windows applications.';
const persistedRow = {
  id: "row-old",
  metadata: JSON.stringify({
    memoryV3InjectedBlock: WINDOWS_CARD,
    memoryV3InjectedCardSlugs: ["skills/windows-automation"],
    memorySkillCardSuppressions: { "conv-other": ["other-skill"] },
  }),
};
let persistedRows = [persistedRow];
const getMessagesMock = mock(async (_conversationId: string) => persistedRows);
const updateMessageMetadataMock = mock(
  async (_messageId: string, _updates: Record<string, unknown>) => {},
);

mock.module("@vellumai/plugin-api", () => ({
  ...realPluginApi,
  getMessages: (conversationId: string) =>
    mockActive
      ? getMessagesMock(conversationId)
      : realPluginApi.getMessages(conversationId),
  parseMessageMetadata: (metadata: string | null) =>
    mockActive
      ? Promise.resolve(metadata ? JSON.parse(metadata) : {})
      : realPluginApi.parseMessageMetadata(metadata),
  updateMessageMetadata: (
    messageId: string,
    updates: Record<string, unknown>,
  ) =>
    mockActive
      ? updateMessageMetadataMock(messageId, updates)
      : realPluginApi.updateMessageMetadata(messageId, updates),
}));

mock.module("../skill-store.js", () => ({
  ...realSkillStore,
  ensureSkillEntriesAvailable: () =>
    mockActive
      ? Promise.resolve()
      : realSkillStore.ensureSkillEntriesAvailable(),
  listSkillEntries: () =>
    mockActive
      ? [
          {
            id: "windows-automation",
            content: "Automates native Windows applications.",
            platforms: ["windows"],
            requiredHostCapabilities: ["host_bash"],
          },
        ]
      : realSkillStore.listSkillEntries(),
}));

const { stripIncompatibleSkillCardsFromMessages } =
  await import("../skill-card-compatibility.js");

beforeEach(() => {
  persistedRows = [persistedRow];
  getMessagesMock.mockClear();
  updateMessageMetadataMock.mockClear();
});

test("persists row suppression for a stripped metadata-less legacy block", async () => {
  const legacyBlock = [
    "# memory/concepts/project.md",
    "Concept lead.",
    "# Skill: windows-automation",
    'The "Windows Automation" skill (windows-automation) is available.',
  ].join("\n\n");
  persistedRows = [
    {
      id: "row-legacy",
      metadata: JSON.stringify({ memoryV3InjectedBlock: legacyBlock }),
    },
    {
      id: "row-not-live",
      metadata: JSON.stringify({
        memoryV3InjectedBlock: `${legacyBlock}\n\nDifferent stored occurrence.`,
      }),
    },
  ];
  const messages = [
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: `<memory>\n${legacyBlock}\n</memory>`,
        },
      ],
    },
  ];

  await stripIncompatibleSkillCardsFromMessages(
    messages,
    {
      clientOs: "windows",
      isInteractive: true,
      sourceActorPrincipalId: "actor-a",
      hostPlatforms: [],
    },
    { conversationId: "conv-1" },
  );

  expect(messages[0]!.content).toEqual([]);
  expect(updateMessageMetadataMock).toHaveBeenCalledTimes(1);
  expect(updateMessageMetadataMock).toHaveBeenCalledWith("row-legacy", {
    memoryV3LegacyBlockSuppressions: ["conv-1"],
  });
});

afterAll(() => {
  mockActive = false;
});

test("persists conversation-scoped suppression for stripped occurrences", async () => {
  const messages = [
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: `<memory>\n${WINDOWS_CARD}\n</memory>`,
        },
      ],
    },
  ];

  await stripIncompatibleSkillCardsFromMessages(
    messages,
    {
      clientOs: "windows",
      isInteractive: true,
      sourceActorPrincipalId: "actor-a",
      hostPlatforms: [],
    },
    { conversationId: "conv-1" },
  );

  expect(messages[0]!.content).toEqual([]);
  expect(getMessagesMock).toHaveBeenCalledWith("conv-1");
  expect(updateMessageMetadataMock).toHaveBeenCalledWith("row-old", {
    memorySkillCardSuppressions: {
      "conv-other": ["other-skill"],
      "conv-1": ["windows-automation"],
    },
  });
});

test("skips the persistence scan when live history has no incompatible card", async () => {
  await stripIncompatibleSkillCardsFromMessages(
    [
      {
        role: "user",
        content: [{ type: "text", text: "ordinary message" }],
      },
    ],
    {
      clientOs: "windows",
      isInteractive: true,
      sourceActorPrincipalId: "actor-a",
      hostPlatforms: [],
    },
    { conversationId: "conv-1" },
  );

  expect(getMessagesMock).not.toHaveBeenCalled();
  expect(updateMessageMetadataMock).not.toHaveBeenCalled();
});
