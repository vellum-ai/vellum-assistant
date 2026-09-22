import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { ToolCallCardItem } from "@/domains/chat/utils/tool-call-card-utils";
import type { ActivityStepsPayload } from "@/stores/viewer-store";

import { DetailPanelStoryFrame } from "@/domains/chat/components/detail-panel-story-frame";
import { attachmentContentQueryKey } from "@/domains/chat/components/chat-attachments/use-attachment-object-url";
import { withQueryCache } from "@/lib/story-query-cache";

import { ActivityStepsPanel } from "./activity-steps-panel";

/**
 * The activity-steps side panel (Figma `6405-121430`): one activity group's
 * full phase-grouped timeline, with in-panel drill-in to step details and an
 * "All steps" back button. Opened by clicking a `MultiActivityGroup` header
 * in the transcript.
 */

function makeToolCall(
  overrides: Partial<ChatMessageToolCall> & { id: string },
): ChatMessageToolCall {
  const startedAt = 1_717_000_000_000;
  return {
    name: "bash",
    input: { command: "date", activity: "Checking the current time" },
    riskLevel: "low",
    startedAt,
    completedAt: startedAt + 2_000,
    result: "ok",
    ...overrides,
  };
}

const START = 1_717_000_000_000;

const WEB_SEARCH = makeToolCall({
  id: "tc-web",
  name: "web_search",
  riskLevel: undefined,
  input: { query: "most popular social media sites" },
  startedAt: START + 2_000,
  completedAt: START + 6_000,
  activityMetadata: {
    webSearch: {
      query: "most popular social media sites",
      provider: "anthropic-native",
      resultCount: 3,
      durationMs: 4_000,
      results: [
        {
          rank: 1,
          title: "This is a webpage title",
          url: "https://example.com/a",
          domain: "example.com",
        },
        {
          rank: 2,
          title: "This is another webpage title",
          url: "https://example.org/b",
          domain: "example.org",
        },
        {
          rank: 3,
          title: "New webpage title",
          url: "https://example.net/c",
          domain: "example.net",
        },
      ],
    },
  },
});

const SKILL = makeToolCall({
  id: "tc-skill",
  name: "skill_execute",
  riskLevel: undefined,
  input: { skill: "critical-thinking", activity: "Using a skill" },
  startedAt: START + 6_000,
  completedAt: START + 54_000,
});

const RISKY_BASH = makeToolCall({
  id: "tc-bash",
  name: "bash",
  riskLevel: "high",
  input: {
    command: "curl -s https://example.com/api",
    activity: "Fetching the example API",
  },
  startedAt: START + 54_000,
  completedAt: START + 60_000,
  result: '{ "status": "ok" }',
});

const ITEMS: ToolCallCardItem[] = [
  {
    kind: "thinking",
    text: "I'll look at the most popular websites first.",
    startedAt: START,
    completedAt: START + 2_000,
  },
  { kind: "toolCall", toolCall: WEB_SEARCH },
  {
    kind: "thinking",
    text: "I'm going to look at some more pages because I'm unsure of this.",
    startedAt: START + 6_000,
    completedAt: START + 7_000,
  },
  { kind: "toolCall", toolCall: SKILL },
  { kind: "toolCall", toolCall: RISKY_BASH },
  {
    kind: "thinking",
    text: "Summarising all I learned into an easily digestible format.",
    startedAt: START + 60_000,
    completedAt: START + 66_000,
  },
];

const TOOL_CALLS = [WEB_SEARCH, SKILL, RISKY_BASH];

const FIRST_DASHBOARD_SCREENSHOT =
  "iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAACoElEQVR42u3boQ2DUBSG0bcIigWYgnW6IJoEh0CRildTUYEjJCgcFgIVvc1JvgnuzZF/KspKUtCSE0gASwJYEsASwJIAlgSwJIAlgCUBLAlgCWBJAEsCWBLAEsCSAJYEsCSAJYAlASwJYAlgSQBLAljSAeDXewrUvKyS9gCWAAZYAhhgCWAJYIAlgAGWAAZYAlgCGGAJYIAlgCWAAZYABlgCGGAJYAlggCWAAZYA9jAJYAngCIDrR9aFzl94zB9dDmCAAQYYYAEMMMAAC2CAAQYYYIABBhhggAEGGGCABTDAAAMMsAAGGGCAAQYYYIABBhhggAEGWAADDDDAAhhggAEGmEaAAQYYYIABBhhgAQwwwAADLIABBhhgAQwwwAADDDDAAAMsgAEGGGABDDDAAAMsgAEGGGCAAQYYYAEMMMAAAyyAAQYYYAEMMMAAAwwwwAADDDDAAAMMsAAGGGCAARbAAAMMMMAAAwwwwAADDDDAAAtggAEGWAADDDDAAAMMMMCxAUv/HcASwABLAAMsASwBDLAEMMASwABLAEsAAywBDLAEsAQwwBLAAEsAAywBLAEcG3DXP6WfDWCABTDAEsAASwADLIABBlgAAywBDLAEMMACGGAJYIAlgAEWwAADLIABlgA2J5TMCQGWAJYABlgCGGAJYEkASwADLAEMsASwBDDAEsAASwDfA9y0g3QygAEWwAADLIABBlgAAyyAAQZYAAMMsAAGWAIYYAEMMMACGGCABTDAAhhggAUwwAALYHNCyZwQYAlggCWAJQEsAQywBDDAEsASwABLAAMsAQywBLAEMMASwABLAEsAAywBDLAEMMASwBLAAEsAAywBDLAEsAQwwBLAAEsASwADLAEMsAQwwBLAEsAASwADLH29DSe7+El0/BV7AAAAAElFTkSuQmCC";
const SECOND_DASHBOARD_SCREENSHOT =
  "iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAACmElEQVR42u3bIQ5AABTHYRdRuIATua2gySZQBEEzm6SpDMGzb/ud4L198Z+keSEpaIkTSABLAlgSwBLAkgCWBLAkgCWAJQEsCWAJYEkASwJYEsASwJIAlgSwJIAlgCUBLAlgCWBJAEsCWNIJ4GGcA7Wsm6QjgCWAAZYABlgCWAIYYAlggCWAAZYAlgAGWAIYYAlgCWCAJYABlgAGWAJYAhhgCWCAJYA9TAJYAjgC4KwqdaPrF277SbcDGGCAAQZYAAMMMMACGGCAAQYYYIABBhhggAEGGGABDDDAAAMsgAEGGGCAAQYYYIABBhhggAEWwAADDLAABhhggAGmEWCAAQYYYIABBlgAAwwwwAALYIABBlgAAwwwwAADDDDAAAtggAEGWAADDDDAAAtggAEGGGCAAQZYAAMMMMAAC2CAAQZYAAMMMMAAAwwwwAADDDDAAAMsgAEGGGCABTDAAAMMMMAAAwwwwAADDDDAAhhggAEWwAADDDDAAAMMcGzA0r8DWAIYYAlggCWAJYABlgAGWAIYYAlgCWCAJYABlgCWAAZYAhhgCWCAJYAlgGMDrptO+mwAAyyAAZYABlgCGGABDDDAAhhgCWCAJYABFsAASwADLAEMsAAGGGABDLAEsDmhZE4IsASwBDDAEsAASwBLAlgCGGAJYIAlgCWAAZYABlgC+BngrCqliwEMsAAGGGABDDDAAhhgAQwwwAIYYIAFMMASwAALYIABFsAAAyyAARbAAAMsgAEGWACbE0rmhABLAAMsASwJYAlggCWAAZYAlgAGWAIYYAlggCWAJYABlgAGWAJYAhhgCWCAJYABlgCWAAZYAhhgCWCAJYAlgAGWAAZYAlgCGGAJYIAlgAGWAJYABlgCGGDp9XYa20dtPpc6UgAAAABJRU5ErkJggg==";

const FIRST_SCREENSHOT = makeToolCall({
  id: "tc-screen-first",
  name: "computer_use_screenshot",
  input: { activity: "Opening the example dashboard" },
  imageDataList: [FIRST_DASHBOARD_SCREENSHOT],
  startedAt: START,
  completedAt: START + 2_000,
});
const SECOND_SCREENSHOT = makeToolCall({
  id: "tc-screen-second",
  name: "computer_use_screenshot",
  input: { activity: "Checking the completed dashboard" },
  imageDataList: [SECOND_DASHBOARD_SCREENSHOT],
  startedAt: START + 2_000,
  completedAt: START + 4_000,
});
const GALLERY_CALLS = [FIRST_SCREENSHOT, SECOND_SCREENSHOT];
const GALLERY_ITEMS: ToolCallCardItem[] = GALLERY_CALLS.map((toolCall) => ({
  kind: "toolCall",
  toolCall,
}));

function singleScreenshotPayload(
  toolCall: ChatMessageToolCall,
): ActivityStepsPayload {
  return {
    items: [{ kind: "toolCall", toolCall }],
    toolCalls: [toolCall],
  };
}

function referencedScreenshot(attachmentId: string): ChatMessageToolCall {
  return {
    ...SECOND_SCREENSHOT,
    imageDataList: undefined,
    imageAttachmentIds: [attachmentId],
  };
}

const RUNNING_SCREENSHOT = {
  ...SECOND_SCREENSHOT,
  completedAt: undefined,
  result: undefined,
};
const LOADED_SCREENSHOT = referencedScreenshot("story-loaded");
const LOADING_SCREENSHOT = referencedScreenshot("story-loading");
const UNAVAILABLE_SCREENSHOT = referencedScreenshot("story-unavailable");

function referencedStoryCache(
  attachmentId: string,
  state: "loaded" | "loading",
) {
  return withQueryCache((client) => {
    const key = attachmentContentQueryKey("story-assistant", attachmentId);
    if (state === "loaded") {
      client.setQueryData(
        key,
        new Blob(
          [
            '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="royalblue"/></svg>',
          ],
          { type: "image/svg+xml" },
        ),
      );
    } else {
      void client.prefetchQuery({
        queryKey: key,
        queryFn: () => new Promise<Blob>(() => {}),
      });
    }
  });
}

const LOADED_STORY_CACHE = referencedStoryCache("story-loaded", "loaded");
const LOADING_STORY_CACHE = referencedStoryCache("story-loading", "loading");

const meta: Meta<typeof ActivityStepsPanel> = {
  title: "Chat/ActivityStepsPanel",
  component: ActivityStepsPanel,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <DetailPanelStoryFrame>
        <Story />
      </DetailPanelStoryFrame>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ActivityStepsPanel>;

/**
 * A completed interleaved run: thinking → web search → thinking → skill →
 * bash → thinking. Click any thinking or tool pill to drill into its detail;
 * the "All steps" back button returns to the timeline.
 */
export const CompletedRun: Story = {
  args: {
    payload: { items: ITEMS, toolCalls: TOOL_CALLS },
    onClose: () => {},
  },
};

/**
 * A step opened from the timeline: the tool call's detail, spaced the same as
 * it is in the tool drawer.
 */
export const StepDetail: Story = {
  ...CompletedRun,
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: /Fetching the example API/,
      }),
    );
  },
};

/**
 * Drilled into a thinking step: headed "Thinking" beside the Back button and
 * the brain glyph, the way every panel heads a thinking step.
 */
export const ThinkingStepDetail: Story = {
  ...CompletedRun,
  play: async ({ canvasElement }) => {
    const [firstThinking] = within(canvasElement).getAllByRole("button", {
      name: "View thinking",
    });
    if (firstThinking) {
      await userEvent.click(firstThinking);
    }
  },
};

/**
 * A still-running run — the trailing bash call has no terminal fields, so its
 * phase node renders the running indicator and the header ticks "Working…".
 */
export const StreamingRun: Story = {
  args: {
    payload: {
      items: [
        ...ITEMS.slice(0, 4),
        {
          kind: "toolCall",
          toolCall: makeToolCall({
            id: "tc-running",
            input: {
              command: "sleep 60",
              activity: "Running a long command",
            },
            completedAt: undefined,
            result: undefined,
          }),
        },
      ],
      toolCalls: [
        WEB_SEARCH,
        SKILL,
        makeToolCall({
          id: "tc-running",
          input: { command: "sleep 60", activity: "Running a long command" },
          completedAt: undefined,
          result: undefined,
        }),
      ],
    },
    onClose: () => {},
  },
};

/** Two screenshot occurrences in one Working phase produce one footer tile. */
export const ScreenshotGallery: Story = {
  args: {
    payload: { items: GALLERY_ITEMS, toolCalls: GALLERY_CALLS },
    onClose: () => {},
    assistantId: "story-assistant",
  },
};

/** The real full-screen preview opens from the representative phase tile. */
export const ScreenshotGalleryPreview: Story = {
  ...ScreenshotGallery,
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Preview screenshot from Checking the completed dashboard",
      }),
    );
  },
};

/** A new screenshot-bearing call replaces the Working footer while streaming. */
export const StreamingScreenshotGallery: Story = {
  args: {
    payload: {
      items: [
        { kind: "toolCall", toolCall: FIRST_SCREENSHOT },
        { kind: "toolCall", toolCall: RUNNING_SCREENSHOT },
      ],
      toolCalls: [FIRST_SCREENSHOT, RUNNING_SCREENSHOT],
      active: true,
    },
    onClose: () => {},
    assistantId: "story-assistant",
  },
};

/** A referenced screenshot reuses the assistant-scoped attachment cache. */
export const ReferencedScreenshot: Story = {
  args: {
    payload: singleScreenshotPayload(LOADED_SCREENSHOT),
    onClose: () => {},
    assistantId: "story-assistant",
  },
  decorators: [LOADED_STORY_CACHE],
};

/** The 64px tile holds its place while referenced bytes are still loading. */
export const ReferencedScreenshotLoading: Story = {
  args: {
    payload: singleScreenshotPayload(LOADING_SCREENSHOT),
    onClose: () => {},
    assistantId: "story-assistant",
  },
  decorators: [LOADING_STORY_CACHE],
};

/** A reference with no owning assistant stays operable with the image fallback. */
export const ReferencedScreenshotUnavailable: Story = {
  args: {
    payload: singleScreenshotPayload(UNAVAILABLE_SCREENSHOT),
    onClose: () => {},
    assistantId: null,
  },
};

/** The production panel and preview remain the same composition at mobile width. */
export const ScreenshotGalleryNarrow: Story = {
  ...ScreenshotGallery,
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};
