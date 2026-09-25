import type { Meta, StoryObj } from "@storybook/react-vite";
import { type MouseEvent, useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { client } from "@/generated/daemon/client.gen";
import type {
  DocumentsByIdCommentsGetResponse,
  DocumentsPostResponse,
} from "@/generated/daemon/types.gen";
import { fixtureNotFound, stubClientFetch } from "@/lib/stub-client-fetch";

import { DocumentViewerContainer } from "./document-viewer-container";

const SURFACE_ID = "document-remote-merge-story";
const DOCUMENT = `# Trip notes

Pack light and leave room for surprises.

## Saturday

Walk through the market in the morning.

## Sunday

Take the slow train home.`;
const ASSISTANT_EDIT = DOCUMENT.replace(
  "Take the slow train home.",
  "Take the slow train home and read on the way.",
);
const ASSISTANT_APPEND = `${ASSISTANT_EDIT}\n\n## Checklist\n\nTickets, charger, notebook.`;
const TYPED = " Bring a scarf.";

/** The update arrives while the caret stays in the editor, as a stream would. */
function keepEditorFocus(event: MouseEvent<HTMLButtonElement>) {
  event.preventDefault();
}

function RemoteMergeStory() {
  const [content, setContent] = useState(DOCUMENT);
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-[var(--surface-base)]">
      <div className="flex gap-2 p-2">
        <button
          type="button"
          onMouseDown={keepEditorFocus}
          onClick={() => setContent(ASSISTANT_EDIT)}
        >
          Assistant edits Sunday
        </button>
        <button
          type="button"
          onMouseDown={keepEditorFocus}
          onClick={() => setContent(ASSISTANT_APPEND)}
        >
          Assistant appends a checklist
        </button>
      </div>
      <DocumentViewerContainer
        source="document"
        assistantId="story-remote-merge-assistant"
        conversationId="22222222-2222-4222-8222-222222222222"
        surfaceId={SURFACE_ID}
        documentName="Trip notes"
        content={content}
        onClose={() => {}}
      />
    </div>
  );
}

const meta: Meta<typeof RemoteMergeStory> = {
  title: "Chat/DocumentRemoteMerge",
  component: RemoteMergeStory,
  tags: ["!autodocs"],
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "An assistant edit arriving while the user types merges into the editor instead of replacing it. " +
          "The buttons stand in for streamed document updates; saves use an isolated SDK transport.",
      },
    },
  },
  beforeEach: () =>
    stubClientFetch(client, async (request) => {
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
      return fixtureNotFound();
    }),
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const AssistantEditWhileTyping: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const editor = await waitFor(() => {
      const node = canvasElement.querySelector<HTMLElement>(
        '[contenteditable="true"]',
      );
      expect(node).not.toBeNull();
      return node!;
    });
    const firstParagraph = await waitFor(() => {
      const node = editor.querySelector("p");
      expect(node).not.toBeNull();
      return node!;
    });
    editor.focus();
    const caret = document.createRange();
    caret.selectNodeContents(firstParagraph);
    caret.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(caret);
    await userEvent.keyboard(TYPED);
    await userEvent.click(
      canvas.getByRole("button", { name: "Assistant edits Sunday" }),
    );
    // Local typing is still unsaved, so the update applies once autosave drains.
    await waitFor(() => expect(editor).toHaveTextContent("read on the way."), {
      timeout: 5000,
    });
    await expect(editor).toHaveTextContent(TYPED.trim());
    // The caret stays where the user was typing.
    await userEvent.keyboard(" Gloves too.");
    await expect(firstParagraph).toHaveTextContent(
      `Pack light and leave room for surprises.${TYPED} Gloves too.`,
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Assistant appends a checklist" }),
    );
    await waitFor(
      () => expect(editor).toHaveTextContent("Tickets, charger, notebook."),
      { timeout: 5000 },
    );
    await expect(firstParagraph).toHaveTextContent("Gloves too.");
  },
};
