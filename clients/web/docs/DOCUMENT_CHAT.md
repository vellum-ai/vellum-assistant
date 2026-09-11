# Mobile document chat

The mobile document editor is a presentation of its linked conversation, not a
second messaging session. `ChatPage` and `ActiveChatView` own the ordinary chat
lifecycle. `ChatMainPanel` places `DocumentChatContent` in `ChatBody` above the
existing `ChatComposer`. Both editor and transcript stay mounted while the
document is associated with the route; the inactive region is hidden and inert.
The composer stays at the same React-tree position across
document/conversation presentation changes, preserving focus, uploads and voice
controls.

## Entry and ownership

Library, chat cards and direct document links use the shared document-conversation
entry helpers. The conversation URL records the document surface, its return
destination and whether the document or conversation is visible. This intent
survives refresh without a second chat page, event connection or composer store.
Both the document session and standalone recovery page read through
`loadDocumentContent`, which refetches after pending local save drains settle
and checks request ownership before and after fetching. The retained viewer
snapshot is not a freshness signal. Save waits are scoped by assistant and surface
and retain no document content; presentation switches within the mounted session
keep the existing editor without refetching.
The return destination accepts only supported in-app Library/chat paths,
including the chat router's optional trailing slash.
Conversation bootstrap leaves an explicit conversation URL intact, so it does not
consume the document presentation or return parameters while selecting the chat.
Chat Info stays mounted while document entry resolves, then closes immediately
before navigation. Closing it manually cancels the pending entry request.
The desktop drawer's close action removes document URL intent while preserving
the current conversation, unrelated search parameters and fragment. A failed
mobile document load offers both Retry and Close document; close uses the same
return destination as a loaded editor and removes the failed association.

Documents normally have a conversation: the document upsert API requires a
nonempty `conversationId`. Opening a document validates that existing link. A
missing or deleted conversation offers an explicit repair action; opening the
editor never silently creates a conversation. Repair caches the minted row before
linking so a failed link can retry without creating another row. Assistant and
surface identity scope the entry and editor, including assistants with copied
surface IDs.
Updating an existing document's title and body does not require its original
conversation row to exist. The save upsert preserves its owning ID, so edits can
flush before the explicit repair action links a replacement conversation.

## Prepare, then use normal chat

`useDocumentEditorSave` serializes title and body writes for the mounted editor.
If an older write fails while newer edits are pending, the same save drain attempts
the latest revision, including during close. A failed latest revision rejects
without repeatedly retrying itself.
Successful rename writes invalidate the saved assistant's document-list caches,
even after the editor unmounts or a newer rename supersedes the write. UI callbacks
and save indicators remain scoped to the mounted editor.
`beginSendPreparation` takes a short editing lease, drains pending writes and
returns the current saved title/content. The chat submit hook awaits preparation
before clearing its ordinary draft and attachments, in either presentation.
A failed save, changed owner,
closed editor or changed draft cancels preparation without taking the message.
Feedback uses the saved title. Live-voice entry awaits the same flush before
starting the conversation session; dictation writes to the existing chat input.
Sending during dictation finishes the transcript before document preparation.
An owner change during either wait leaves the message in the ordinary draft.

Once preparation succeeds, `useComposerSubmit` and `useSendMessage` own sending.
There is no document delivery endpoint, pending-message store, reply watcher or
parallel recovery lifecycle. Queue, error, connection, question and approval
controls are the existing chat surfaces. The document navigation row reports
working/needs-input status and offers View conversation or Reopen document.
See [Conversation SSE](./CONVERSATION_SSE.md) for delivery and stream ownership.

## Layout and compatibility

The mobile editor lives inside the existing keyboard-aware app shell rather than
moving the composer into an overlay portal. The document header replaces the chat
header; the editor scrolls independently above the composer. The app shell remains
the single owner of visual-viewport and safe-area geometry.

Desktop uses its existing side drawer. Read-only workspace-file previews retain a
separate mobile overlay and cannot send document feedback. Comment updates use the
existing global event bus and document-comment event hook. Export, comments and
rename remain owned by `DocumentViewerContainer`.
Standalone and in-chat document hosts share `useDocumentPdfExport` for PDF download
and failure feedback, using the existing per-platform file-saving path.

## Verification boundaries

The tests cover entry ownership and repair, save ordering and locks, preparation
cancellation, and composer identity across presentation changes. Storybook uses
production editor/composer components for mobile and desktop presentation states;
its network fixtures are not proof of message delivery or native microphone use.
Real-device keyboard, native picker and microphone checks remain a separate manual
validation step.

The [review disposition ledger](./DOCUMENT_CHAT_REVIEW_LEDGER.md) records relevant
findings from the predecessor PR, including normal-chat baseline limitations that
are independent of document presentation.
