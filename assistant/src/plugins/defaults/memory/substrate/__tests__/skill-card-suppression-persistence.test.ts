import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const realPluginApi = await import("@vellumai/plugin-api");
const realSkillStore = await import("../skill-store.js");
const realEverInjectedStore = await import("../../v3/ever-injected-store.js");

let mockActive = true;
let mockPrunedSlugs = new Set<string>();
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

mock.module("../../v3/ever-injected-store.js", () => ({
  ...realEverInjectedStore,
  getPrunedSlugs: (conversationId: string) => {
    if (!mockActive) {
      return realEverInjectedStore.getPrunedSlugs(conversationId);
    }
    return mockPrunedSlugs;
  },
}));

const { stripIncompatibleSkillCardsFromMessages } =
  await import("../../v3/skill-card-compatibility.js");
const { filterPrunedCardSections } = await import("../../v3/prune.js");

beforeEach(() => {
  persistedRows = [persistedRow];
  mockPrunedSlugs = new Set();
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

test("matches a metadata-less legacy block after concept pruning", async () => {
  const legacyBlock = [
    "# memory/concepts/project.md",
    "Pruned concept content.",
    "# Skill: windows-automation",
    'The "Windows Automation" skill (windows-automation) is available.',
  ].join("\n\n");
  persistedRows = [
    {
      id: "row-pruned-legacy",
      metadata: JSON.stringify({ memoryV3InjectedBlock: legacyBlock }),
    },
  ];
  mockPrunedSlugs = new Set(["project"]);
  const liveBlock = filterPrunedCardSections(legacyBlock, mockPrunedSlugs);

  await stripIncompatibleSkillCardsFromMessages(
    [
      {
        role: "user",
        content: [{ type: "text", text: `<memory>\n${liveBlock}\n</memory>` }],
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

  expect(updateMessageMetadataMock).toHaveBeenCalledWith("row-pruned-legacy", {
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
