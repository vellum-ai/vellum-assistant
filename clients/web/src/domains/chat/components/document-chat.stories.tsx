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
import { fixtureNotFound, stubClientFetch } from "@/lib/stub-client-fetch";
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
  message(
    "message-1",
    "user",
    "Draft a short guide to planning a quiet weekend.",
  ),
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

const WORKING_TRANSCRIPT = [
  ...TRANSCRIPT,
  message("message-3", "user", DRAFT),
  message(
    "message-4",
    "assistant",
    "I'm revising the introduction to make it shorter.",
  ),
];

interface DocumentChatStoryProps {
  state:
    | "editing"
    | "idle"
    | "uploading"
    | "working"
    | "queued"
    | "error"
    | "needs-input";
  layout: "mobile" | "desktop";
}

function DocumentChatStory({ state, layout }: DocumentChatStoryProps) {
  const [presentation, setPresentation] = useState<"document" | "conversation">(
    "document",
  );
  const [queuedMessages, setQueuedMessages] = useState(
    state === "queued" ? [QUEUED_MESSAGE] : [],
  );
  const [isBusy, setIsBusy] = useState(
    state === "working" || state === "queued",
  );
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const voiceInputRef = useRef<VoiceInputButtonHandle | null>(null);
  const showingDocument = presentation === "document";
  const transcript =
    state === "working" || state === "queued" ? WORKING_TRANSCRIPT : TRANSCRIPT;
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
      onViewConversation={layout === "mobile" ? viewConversation : undefined}
    />
  );
  const chat = (
    <ChatBody
      variant="main"
      scrollAreaProps={{
        isLoadingHistory: false,
        messageCount: transcript.length,
        showMaintenanceRecoveryCard: false,
        showEmptyState: false,
        emptyStateProps: {},
        transcriptRef: null,
        transcriptProps: {
          items: transcript,
          conversationId: CONVERSATION_ID,
          assistantId: ASSISTANT_ID,
          onSurfaceAction: () => {},
        },
      }}
      documentSlot={layout === "mobile" ? documentViewer : undefined}
      documentPresentation={presentation}
      sessionNavigationSlot={
        layout === "mobile" && !showingDocument ? (
          <DocumentChatNavigation
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
          isAssistantBusy={isBusy}
          onStopGenerating={() => {
            setIsBusy(false);
            useTurnStore.setState({ phase: "idle" });
          }}
          onAddAttachmentFiles={(files) => {
            useComposerStore.getState().addFiles(files, ASSISTANT_ID);
          }}
          voiceInputRef={voiceInputRef}
          onVoiceTranscript={(text) =>
            useComposerStore.getState().setInput(text)
          }
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
          "The document header's chat icon and Reopen document keep one composer mounted, without a navigation strip below the editor. " +
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
    const hasDraft =
      args.state === "idle" ||
      args.state === "uploading" ||
      args.state === "error";
    useComposerStore.setState({
      input: hasDraft ? DRAFT : "",
      restoredDraftConversationId: null,
      attachmentLastError: null,
      attachments:
        args.state === "uploading"
          ? [
              {
                kind: "uploading",
                localId: "attachment-uploading-1",
                filename: "trip-checklist.pdf",
                mimeType: "application/pdf",
                sizeBytes: 4096,
              },
            ]
          : hasDraft
            ? [ATTACHMENT]
            : [],
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
        args.state === "working" || args.state === "queued"
          ? "thinking"
          : args.state === "needs-input"
            ? "awaiting_user_input"
            : "idle",
      pendingQueuedCount: args.state === "queued" ? 1 : 0,
    });
    const restoreClient = stubClientFetch(client, async (request) => {
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
      return fixtureNotFound();
    });
    return () => {
      useComposerStore.setState(composerSnapshot, true);
      useInteractionStore.setState(interactionSnapshot, true);
      useTurnStore.setState(turnSnapshot, true);
      restoreClient();
    };
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const MobileIdle: Story = {};
export const MobileDirectEditing: Story = { args: { state: "editing" } };
export const MobileDark: Story = { globals: { theme: "dark" } };
export const MobileUploading: Story = { args: { state: "uploading" } };
export const MobileWorking: Story = { args: { state: "working" } };
export const MobileQueued: Story = { args: { state: "queued" } };
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
    const viewConversation = canvas.getByRole("button", {
      name: "View conversation",
    });
    await expect(viewConversation.closest("header")).not.toBeNull();
    await expect(
      canvas.queryByText("Replies appear in the conversation"),
    ).toBeNull();
    await expect(
      canvasElement.querySelector('[data-slot="document-chat-navigation"]'),
    ).toBeNull();
    await userEvent.click(viewConversation);
    await expect(canvas.getByPlaceholderText(PLACEHOLDER)).toBe(textarea);
    await expect(textarea).toHaveValue(expectedDraft);
    await expect(canvas.getByText(ATTACHMENT.filename)).toBeVisible();
    await expect(editor).not.toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Reopen document" }),
    );
    await expect(canvas.getByPlaceholderText(PLACEHOLDER)).toBe(textarea);
    await expect(textarea).toHaveValue(expectedDraft);
    await expect(canvas.getByText(ATTACHMENT.filename)).toBeVisible();
    await expect(
      canvasElement.querySelector(
        '[data-slot="document-content"] [contenteditable="true"]',
      ),
    ).toBe(editor);
    await expect(editor).toBeVisible();
    await expect(editor).toHaveTextContent(edit.trim());
    await expect(
      canvasElement.querySelector('[data-slot="document-chat-navigation"]'),
    ).toBeNull();
    await expect(canvasElement.querySelectorAll("textarea")).toHaveLength(1);
  },
};
