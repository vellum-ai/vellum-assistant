# Preserve chat attachments across rotation

## Goal and scope

Rotating or resizing the current chat preserves attachments, pending uploads,
draft text, and the mounted composer. Actual conversation/assistant changes
and successful sends retain their existing cleanup behavior.

Implement one focused PR, with production changes centered on two files:

- [`chat-session-store.ts`](../clients/web/src/domains/chat/chat-session-store.ts):
  make repeated entry into the same session harmless.
- [`chat-layout.tsx`](../clients/web/src/domains/chat/chat-layout.tsx):
  keep the chat subtree mounted across responsive layouts.

Use the existing store, upload lifecycle, media query, and reconciliation
paths. Keep this change free of new persistence, state managers, feature flags,
orientation listeners, breakpoint changes, and native/backend changes. Limit
cleanup to duplicated layout code removed by the fix. Add a short note to
`clients/web/docs/PLATFORM_ADAPTATION.md` about preserving stateful route
ancestry; a broader architecture rewrite is unnecessary.

## Evidence and limits

Crossing the 768px breakpoint replaces the chat's parent tree. The remounted
[`useConversationHistory`](../clients/web/src/domains/chat/hooks/use-conversation-history.ts)
consumer calls `switchToConversation` with unchanged IDs. That action clears
attachments, marks pending uploads cancelled, and resets other session state.
Draft text survives because its handler checks whether the conversation changed.
Reusing a JSX variable across different parents does not preserve the mounted
tree ([React documentation](https://react.dev/learn/preserving-and-resetting-state)).

An isolated reproduction extracted the actual layout branch, mount effect,
and reset actions and ran them with the repository's React 19.2.6 and Zustand
5.0.13 versions. Uploaded, uploading, and failed attachments disappeared on a
breakpoint crossing. An in-memory guard candidate retained them and still
cleared attachments on genuine identity changes. The guard alone left the
chat remounting.

This confirms the code path, not the complete device experience. The report
appears to involve iOS; app versus Safari is unknown. The focused implementation
and repository validation are complete in this checkout. Physical-device and
authenticated browser validation remain outstanding.

## Execution plan

### 1. Protect same-session entry first

- [x] Add focused store regression coverage, then add the identity guard in
  `switchToConversation`: return when both previous IDs match the requested
  assistant and conversation.
- [x] Keep draft-resolution handling before the guard, and place the guard
  before destructive resets. Preserve first-load initialization and genuine
  switch behavior.
- [x] Verify same-session entry preserves attachment IDs/previews/errors, draft
  text, transcript/optimistic sends, and live turn/interaction state.
- [x] Verify real conversation and assistant switches still clean up; test
  draft materialization followed by a real switch. Assert that the one-shot
  draft-resolution flag is consumed even when IDs already match.

Use the real store actions in these tests. Keep any reproduction that lands
separately from its implementation as `test.todo`; the final PR stays green.
Do not change upload ownership or draft storage to make these tests pass.

### 2. Keep the existing chat tree stable

- [x] Replace the separate narrow/wide/popout body branches with one stable
  wrapper and `main`/`Outlet` ancestry. Use conditional classes for spacing and
  sizing, and conditional siblings for the sidebar and overlays.
- [x] Remove the duplicated body markup while preserving the current visual
  layout. Keep the mobile drawer outside the blurred/filtered `main`, preserve
  voice-room and sleep-stage layering, and retain the existing inert behavior.
- [x] Add a layout regression that crosses 767px to 768px and back and asserts
  that the chat mounts once and the textarea is the same DOM node. Include a
  same-side resize and a popout case.

Test the production layout path, mocking unrelated chrome and network work as
needed. Avoid a test-only copy of the layout or a new generic layout framework.
Do not keep separate hidden mobile and desktop chat instances mounted.

### 3. Check recovery and upload behavior

- [x] Extend an existing hook test to re-enter the same assistant/conversation
  after a remount or inactive-to-active transition. Verify attachments survive
  and current server state still reaches the UI through normal reconciliation.
- [x] Run the existing reconnect-refetch, pending-question, resume-grace, and
  processing-revalidation tests. Check that resolved prompts retire, completed
  turns settle, and recovered history errors clear through their existing owners.
- [x] Add one deferred-upload regression: rotate while uploading, resolve the
  upload, and assert that its original row becomes uploaded exactly once.
  Verify the send uses the uploaded attachment ID and clears the composer.
- [x] Run the relevant new/changed tests plus existing composer submission and
  attachment-cleanup coverage, then lint changed files and typecheck the web app.

Run Bun tests with explicit file paths, individually where module mocks require
isolation. Use the repository-pinned toolchain and workspace lockfile. Reuse
existing fixtures and mocks; add new cases only for uncovered behavior.

If a recovery test exposes reliance on the old reset, fix the demonstrated
case in its existing reconciliation owner. Broader lifecycle redesign is a
separate effort, not a prerequisite for this bug fix.

### 4. Verify the device behavior and review

- [ ] On both the iOS app and Safari, use a viewport that crosses 768 CSS pixels.
  Attach an image and a document, rotate both directions, preview, and send.
  Repeat with a pending upload and keyboard open; cover a new draft and an
  existing conversation across these checks.
- [ ] Resize a desktop browser across the breakpoint. Briefly check the drawer,
  desktop sidebar, voice-room/sleep overlay, and popout layout. Check safe areas
  and that the composer remains reachable with the iOS keyboard visible.
- [ ] Smoke-test Android when a device or emulator is available because the
  changed web code is shared. Record any unavailable device coverage in the PR.
- [x] Review the final diff around reset ordering and layout ancestry. Keep one
  logical PR with focused validation results and the remaining device limits.

## Validation status

Validation used the repository-pinned Bun 1.3.11 toolchain after
`export PATH="$HOME/.bun/bin:$PATH"`. The frozen workspace install used the
existing lockfile, skipped lifecycle scripts, and was followed by the required
web OpenAPI client generation. The install left `bun.lock` and package manifests
unchanged.

- Nine focused test files passed in separate processes: 177 tests and 482
  assertions. Coverage includes stable layout ancestry, same-session state,
  deferred upload completion and send cleanup, reconnect refetch, pending
  interaction recovery, resume grace, processing revalidation, composer submit,
  and conversation attachment behavior.
- ESLint passed for every changed TypeScript and TSX file.
- `tsc --noEmit` passed for `clients/web`.
- Auth review follow-up covers SPA logout and login with reused assistant and
  conversation IDs. The logout storage seam cancels the old SSE epoch and
  clears conversation, transcript, composer, turn, and interaction state.
  Focused regressions also verify that late uploads and failed or successful
  sends cannot write drafts, prompts, transcript rows, or processing state into
  the next authenticated session. Independent review and targeted lint passed.
- Recovery review follow-up clears a resolved or replaced confirmation from
  both the materialized transcript and the history cache while preserving the
  current prompt, unrelated markers, attention state, and stale-read guards.
  The focused history recovery suite passes with 23 tests and 63 assertions.
- Three deterministic CI test mocks for email settings, resize settings, and
  subagent stream handling spread their real modules before overriding the
  focused dependency. Their 24 scoped tests pass.
- A localhost Vite and headless Chromium smoke reached the assistant selection
  screen at 767px and 768px. It could not reach chat because the supporting
  local auth, feature-flag, and assistant services were unavailable. This does
  not count as visual chat acceptance.
- iOS app, iOS Safari, Android, authenticated desktop chat, keyboard, drawer,
  sidebar, overlay, and attachment preview/send checks remain outstanding.

## Risk controls

| Risk | Mitigation |
| --- | --- |
| Stale prompts, turn state, or errors survive recovery | Same-identity lifecycle test plus existing reconciliation tests |
| A real switch retains another chat's state | Explicit conversation/assistant switch tests, including draft resolution |
| Pending upload is lost or sent twice | Deferred upload completion and send assertions |
| Drawer, overlays, keyboard, or safe areas regress | Preserve current layering and run targeted iOS/desktop visual checks |
| Change spreads beyond this bug | Two primary production files plus one demonstrated recovery owner; reuse existing state and reconciliation mechanisms |

## Done when

- Rotation keeps the same mounted chat/composer and all pending attachments.
- Uploads complete normally and sending afterward includes each attachment once.
- Genuine switches, initial load, reconnect recovery, and send cleanup pass the
  focused checks.
- iOS app and Safari validation passes, or any remaining device limitation is
  explicitly recorded for follow-up before treating the fix as fully verified.
- No new storage format, API contract, dependency, or cross-conversation draft
  behavior is introduced.
