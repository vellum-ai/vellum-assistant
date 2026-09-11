import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import {
  useComposerStore,
  type ChatAttachment,
} from "@/domains/chat/composer-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { message } from "@/domains/chat/transcript/transcript-story-fixtures";
import { INITIAL_TURN_STATE, useTurnStore } from "@/domains/chat/turn-store";
import { client } from "@/generated/daemon/client.gen";
import type {
  AttachmentsPostResponse,
  DocumentsByIdCommentsGetResponse,
  DocumentsPostResponse,
} from "@/generated/daemon/types.gen";

import { AnimatedRightDrawer } from "./animated-right-drawer";
import { ChatBody } from "./chat-body";
import { ChatComposer } from "./chat-composer/chat-composer";
import { DocumentChatNavigation } from "./document-chat-navigation";
import { DocumentViewerContainer } from "./document-viewer-container";
import { QueuedMessagesDrawer } from "./queued-messages-drawer";
import type { VoiceInputButtonHandle } from "./voice-input-button";

const ASSISTANT_ID = "story-document-assistant";
const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const SURFACE_ID = "document-story-1";
const DRAFT = "Make the opening paragraph more concise.";
const PLACEHOLDER = "Message about this document";
const DOCUMENT = `# A quiet weekend away

The best weekend plans leave enough room to change your mind. Start with one place you want to visit, then leave the rest of the day open.

## Before you go

- Pick a destination within a short train ride.
- Book somewhere close to the station.
- Pack a notebook and comfortable shoes.

## A slower Saturday

Find a cafe, walk through the local market, and take the long route back. A good trip does not need a full itinerary.

## Coming home

Leave the afternoon free so the journey home feels like part of the break.`;

const ATTACHMENT: ChatAttachment = {
  kind: "uploaded",
  localId: "attachment-local-1",
  id: "attachment-1",
  filename: "weekend-notes.txt",
  mimeType: "text/plain",
  sizeBytes: 256,
  previewUrl: null,
};

const TRANSCRIPT = [
  message("message-1", "user", "Draft a short guide to planning a quiet weekend."),
  message(
    "message-2",
    "assistant",
    "The draft is ready. What would you like to change?",
  ),
];

const QUEUED_MESSAGE = message(
  "queued-message-1",
  "user",
  "Also add a short packing checklist.",
).message;

interface DocumentChatStoryProps {
  state: "idle" | "uploading" | "working" | "error" | "needs-input";
  layout: "mobile" | "desktop";
}

function DocumentChatStory({ state, layout }: DocumentChatStoryProps) {
  const [presentation, setPresentation] = useState<"document" | "conversation">(
    "document",
  );
  const [queuedMessages, setQueuedMessages] = useState(
    state === "working" ? [QUEUED_MESSAGE] : [],
  );
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const voiceInputRef = useRef<VoiceInputButtonHandle | null>(null);
  const showingDocument = presentation === "document";
  const status =
    state === "working" || state === "needs-input" ? state : "idle";
  const viewConversation = () => setPresentation("conversation");
  const documentViewer = (
    <DocumentViewerContainer
      source="document"
      assistantId={ASSISTANT_ID}
      conversationId={CONVERSATION_ID}
      surfaceId={SURFACE_ID}
      documentName="A quiet weekend away"
      content={DOCUMENT}
      onClose={viewConversation}
    />
  );
  const chat = (
    <ChatBody
      variant="main"
      scrollAreaProps={{
        isLoadingHistory: false,
        messageCount: TRANSCRIPT.length,
        showMaintenanceRecoveryCard: false,
        showEmptyState: false,
        emptyStateProps: {},
        transcriptRef: null,
        transcriptProps: {
          items: TRANSCRIPT,
          conversationId: CONVERSATION_ID,
          assistantId: ASSISTANT_ID,
          onSurfaceAction: () => {},
        },
      }}
      documentSlot={layout === "mobile" ? documentViewer : undefined}
      documentPresentation={presentation}
      sessionNavigationSlot={
        layout === "mobile" ? (
          <DocumentChatNavigation
            presentation={presentation}
            status={status}
            onViewConversation={viewConversation}
            onReopenDocument={() => setPresentation("document")}
          />
        ) : undefined
      }
      composerSlot={
        <ChatComposer
          placeholder={PLACEHOLDER}
          onSubmit={(event) => event.preventDefault()}
          inputRef={inputRef}
          typingDisabled={false}
          sendDisabled={false}
          assistantId={ASSISTANT_ID}
          conversationId={CONVERSATION_ID}
          isAssistantBusy={state === "working"}
          onStopGenerating={() => {}}
          onAddAttachmentFiles={(files) => {
            useComposerStore.getState().addFiles(files, ASSISTANT_ID);
          }}
          voiceInputRef={voiceInputRef}
          onVoiceTranscript={(text) => useComposerStore.getState().setInput(text)}
          onVoiceBeforeStart={() => false}
        />
      }
      queuedDrawerSlot={
        <QueuedMessagesDrawer
          queuedMessages={queuedMessages}
          onCancelMessage={(id) =>
            setQueuedMessages((items) => items.filter((item) => item.id !== id))
          }
          onCancelAll={() => setQueuedMessages([])}
          onSteer={() => {}}
          onEditTail={() => {}}
        />
      }
      genericChatError={
        state === "error"
          ? { message: "Your message could not be sent. Please try again." }
          : null
      }
      dragHandlers={{
        onDragEnter: () => {},
        onDragOver: () => {},
        onDragLeave: () => {},
        onDrop: () => {},
      }}
      isAttachmentDragOver={false}
      showScrollToLatest={false}
      onScrollToLatest={() => {}}
      refreshFeedback={null}
      onDismissRefreshFeedback={() => {}}
      onRetryRefresh={() => {}}
    />
  );

  if (layout === "desktop") {
    return (
      <AnimatedRightDrawer
        open={showingDocument}
        left={chat}
        right={documentViewer}
      />
    );
  }
  return chat;
}

const meta: Meta<typeof DocumentChatStory> = {
  title: "Chat/DocumentChat",
  component: DocumentChatStory,
  tags: ["!autodocs"],
  args: { state: "idle", layout: "mobile" },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Production ChatBody, ChatComposer and DocumentViewerContainer with presentation fixtures. " +
          "View conversation and Reopen document keep one composer mounted. " +
          "Document saves and file uploads use an isolated SDK transport. " +
          "Sending, queue processing and microphone recording are not simulated; these stories do not verify delivery or route orchestration.",
      },
    },
  },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
  decorators: [
    (Story) => (
      <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-[var(--surface-base)]">
        <Story />
      </div>
    ),
  ],
  beforeEach: ({ args }) => {
    const composerSnapshot = useComposerStore.getState();
    const interactionSnapshot = useInteractionStore.getState();
    const turnSnapshot = useTurnStore.getState();
    const clientSnapshot = client.getConfig();
    useComposerStore.setState({
      input: DRAFT,
      restoredDraftConversationId: null,
      attachmentLastError: null,
      attachments:
        args.state === "uploading"
          ? [{
              kind: "uploading",
              localId: "attachment-uploading-1",
              filename: "trip-checklist.pdf",
              mimeType: "application/pdf",
              sizeBytes: 4096,
            }]
          : [ATTACHMENT],
    });
    useInteractionStore.getState().resetAll();
    if (args.state === "needs-input") {
      useInteractionStore.getState().showQuestion({
        requestId: "question-request-1",
        entries: [
          {
            id: "question-1",
            question: "Which part should I revise?",
            options: [
              { id: "intro", label: "The introduction" },
              { id: "checklist", label: "The packing checklist" },
            ],
          },
        ],
      });
    }
    useTurnStore.setState({
      ...INITIAL_TURN_STATE,
      phase:
        args.state === "working"
          ? "thinking"
          : args.state === "needs-input"
            ? "awaiting_user_input"
            : "idle",
      pendingQueuedCount: args.state === "working" ? 1 : 0,
    });
    client.setConfig({
      baseUrl: "https://storybook.invalid",
      fetch: Object.assign(async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/documents") && request.method === "POST") {
          return Response.json({
            success: true,
            surfaceId: SURFACE_ID,
          } satisfies DocumentsPostResponse);
        }
        if (path.endsWith("/comments") && request.method === "GET") {
          return Response.json({
            comments: [],
          } satisfies DocumentsByIdCommentsGetResponse);
        }
        if (path.endsWith("/attachments") && request.method === "POST") {
          const data = await request.formData();
          const file = data.get("file");
          if (file instanceof File) {
            return Response.json({
              id: "attachment-story-upload",
              filename: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
              kind: "document",
            } satisfies AttachmentsPostResponse);
          }
        }
        return Response.json(
          { error: "This request is not part of the presentation fixture." },
          { status: 404 },
        );
      }, { preconnect: () => {} }),
    });
    return () => {
      useComposerStore.setState(composerSnapshot, true);
      useInteractionStore.setState(interactionSnapshot, true);
      useTurnStore.setState(turnSnapshot, true);
      client.setConfig(clientSnapshot);
    };
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const MobileIdle: Story = {};
export const MobileDark: Story = { globals: { theme: "dark" } };
export const MobileUploading: Story = { args: { state: "uploading" } };
export const MobileWorking: Story = { args: { state: "working" } };
export const MobileError: Story = { args: { state: "error" } };
export const MobileNeedsInput: Story = { args: { state: "needs-input" } };
export const Desktop: Story = {
  args: { layout: "desktop" },
  globals: { viewport: { value: "sbDesktop", isRotated: false } },
};

export const MobilePreservesComposer: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const textarea = await canvas.findByPlaceholderText(PLACEHOLDER);
    const editor = await waitFor(() => {
      const node = canvasElement.querySelector<HTMLElement>(
        '[data-slot="document-content"] [contenteditable="true"]',
      );
      expect(node).not.toBeNull();
      return node!;
    });
    const edit = " Leave room for surprises.";
    await userEvent.type(editor, edit);
    await expect(editor).toHaveTextContent(edit.trim());
    await userEvent.type(textarea, " Keep the relaxed tone.");
    const expectedDraft = `${DRAFT} Keep the relaxed tone.`;
    await userEvent.click(
      canvas.getByRole("button", { name: "View conversation" }),
    );
    await expect(canvas.getByPlaceholderText(PLACEHOLDER)).toBe(textarea);
    await expect(textarea).toHaveValue(expectedDraft);
    await expect(canvas.getByText(ATTACHMENT.filename)).toBeVisible();
    await expect(editor).not.toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Reopen document" }));
    await expect(canvas.getByPlaceholderText(PLACEHOLDER)).toBe(textarea);
    await expect(textarea).toHaveValue(expectedDraft);
    await expect(canvas.getByText(ATTACHMENT.filename)).toBeVisible();
    await expect(canvasElement.querySelector(
      '[data-slot="document-content"] [contenteditable="true"]',
    )).toBe(editor);
    await expect(editor).toBeVisible();
    await expect(editor).toHaveTextContent(edit.trim());
    await expect(canvasElement.querySelectorAll("textarea")).toHaveLength(1);
  },
};
