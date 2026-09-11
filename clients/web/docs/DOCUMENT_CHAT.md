# Mobile document chat

The mobile document editor is a presentation of its linked conversation, not a
second messaging session. `ChatPage` and `ActiveChatView` own the ordinary chat
lifecycle. `ChatContentLayout` owns the document route state shared by both
viewport layouts. `ChatMainPanel` places `DocumentChatContent` in `ChatBody` above the
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
Fresh chat entry, the document session and standalone recovery page read through
`loadDocumentContent`, which refetches after pending local save drains settle
and checks request ownership before and after fetching. The retained viewer
snapshot is not a freshness signal. Save waits are scoped by assistant and surface.
A failed drain retains the original editor's save callback and dirty revision in
memory. Retry or reopening reattempts that drain before fetching, so the server's
older body cannot replace an unsaved edit. Success releases the callback; ending
the assistant session clears retained drains and invalidates old editor callbacks,
including late completions. This is not durable recovery across page reloads.
Presentation switches within the mounted session keep the existing editor without
refetching.
Reopening the associated document from Chat Info or a chat card uses that same
presentation action, retaining the editor, original return destination and history
state on both viewport layouts. An in-progress session load remains owned by the route.
The return destination accepts only supported in-app Library/chat paths,
including the chat router's optional trailing slash.
Library's optional trailing slash is also preserved, so click-opened document
sessions can pop back to the exact original entry without duplicating history.
Return navigation strips that optional slash from the selected conversation ID
while preserving the destination URL, so returning to the current chat keeps its
live subagent, workflow and transcript-panel state.
Click-opened documents carry history state for their surface and safe origin.
Closing pops that entry; cold links replace themselves with the safe return
route. Widening a click-opened session to desktop preserves this history return;
cold desktop drawer links dismiss within the current conversation.
Adapter redirects, recovery and presentation changes replace the document
entry and retain its state. Prompt consumption also preserves the state. Origins
with auto-send commands or another document association do not opt into history
return, so closing cannot replay a command or reopen an unrelated document.
Conversation bootstrap leaves an explicit conversation URL intact, so it does not
consume the document presentation or return parameters while selecting the chat.
Chat Info stays mounted while document entry resolves, then closes immediately
before navigation. Closing it manually cancels the pending entry request.
The desktop drawer's close button and Escape action remove document URL intent
while preserving the current conversation, unrelated search parameters and
fragment. Opening another desktop viewer replaces the document session, cancels
its pending load and removes its URL intent without closing the replacement.
This includes another document or workspace-file preview, even when the viewer
stays in document mode or the route was showing the transcript.
Pending editor saves still drain on unmount. Closing the replacement or refreshing
does not reopen the document. Mobile overlays and transcript presentation retain
their associated document session.
The mobile document session handles unclaimed Escape from the keyboard
or Android Back through the same return action as its close button. Other active
overlays and controls that claim Escape take priority. Loading and failed mobile
document loads offer Close document; errors also offer Retry. Close cancels the
pending load and uses the same return destination as a loaded editor.
The mobile document host registers its header only while it supplies a close
action. The layout retains its navigation before that registration, including
authentication, assistant lifecycle and first-message setup screens, and restores
it when the host unmounts. Registration cleanup preserves a newer header owner.
Route exit, including browser Back to Library, clears the route-owned document
target and snapshot. Cleanup checks target reference identity so it preserves a
newer entry, including one for the same surface, and leaves other active panels
alone. Browser Forward reloads the document through the ordinary save-aware path.

Documents normally have a conversation: the document upsert API requires a
nonempty `conversationId`. Opening a document validates that existing link. A
missing or deleted conversation offers an explicit repair action; opening the
editor never silently creates a conversation. Repair caches the minted row before
linking so a failed link can retry without creating another row. Assistant and
surface identity scope the entry and editor, including assistants with copied
surface IDs.
Assistants before 0.8.4 retain the validated cached edit conversation without
calling the unsupported document-link endpoint. The link gate waits for the
owning assistant's version and checks request ownership before writing. On
supported versions, a failed link prevents navigation and remains retryable.
Explicit conversation creation requires 0.8.6 or later.
Updating an existing document's title and body does not require its original
conversation row to exist. The save upsert preserves its owning ID, so edits can
flush before the explicit repair action links a replacement conversation.

PDF export from either document host drains the mounted editor's pending saves
and uses the saved title. Save failure, editor replacement or an assistant switch
before the drain completes prevents the download.

## Prepare, then use normal chat

`useDocumentEditorSave` serializes title and body writes for the mounted editor.
If an older write fails while newer edits are pending, the same save drain attempts
the latest revision, including during close. A failed latest revision rejects
without repeatedly retrying itself.
Changed incoming document fields are retained during a save or preparation lease
and applied after the drain and final lease release. Unchanged props cannot replay
an old body during a title refresh, and failed local writes keep their draft until
a successful retry. Deferred updates belong only to the mounted editor.
A later accepted local edit discards the older deferred value for that field only.
Body edits preserve deferred title changes, renames preserve deferred body changes,
and edits rejected by a preparation lease leave deferred updates intact.
Successful rename writes invalidate the saved assistant's document-list caches,
even after the editor unmounts or a newer rename supersedes the write. UI callbacks
and save indicators remain scoped to the mounted editor.
`beginSendPreparation` takes a short editing lease, drains pending writes and
returns the current saved title/content. The chat submit hook awaits preparation
before clearing its ordinary draft and attachments, in either presentation.
The editing lease remains active while the message waits in the ordinary send
chain, then releases as its send handler takes ownership, without waiting for the
delivery response. Cancellation or a thrown handoff also releases the lease.
A failed save, changed owner,
closed editor or changed draft cancels preparation without taking the message.
Feedback uses the saved title. Mobile and desktop feedback share the preparation
runner, which validates ownership and releases the editing lease after navigation.
Desktop feedback waits for saves in both URL-backed and ordinary drawers; failures
show an error beside the retained, editable draft. A desktop drawer can target a
different linked conversation while still checking the active chat for cancellation.
Live-voice entry awaits the same flush before
starting the conversation session; dictation writes to the existing chat input.
Sending during dictation finishes the transcript before document preparation.
An owner change during either wait leaves the message in the ordinary draft.
The retained document also prepares sends and voice entry while an app is
minimized to its strip, using the shared pane arrangement to recognize the exposed
conversation. Restoring the full app during a save cancels preparation and clears
its pending status, so minimizing again leaves the composer ready to retry.

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
Crossing the mobile breakpoint invalidates the document host's load state before
the incoming editor mounts. The outgoing editor flushes on unmount, and the shared
route waits for that drain before refetching; failures show Retry and Close while
retaining the failed drain for retry. The desktop drawer releases its editor before
the mobile load rather than retaining it through the closing animation. A document
opened on desktop without URL intent enters the existing mobile document adapter
when the viewport narrows, preserving the current chat as its return destination.
Desktop loads record the owning assistant for this handoff. Workspace-file previews
keep their separate responsive path.
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
