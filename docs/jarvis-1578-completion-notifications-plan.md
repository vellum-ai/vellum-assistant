# Completion notifications on desktop and web

Implementation plan for [JARVIS-1578](https://linear.app/vellum/issue/JARVIS-1578/notify-on-desktop-and-web-when-the-assistant-finishes-and-when).

Status: implementation and source review complete; automated checks pass. Live device acceptance remains pending. Updated September 22, 2026.

The user confirmed that browser support covers a Vellum tab that remains open. Notifications after the tab is closed are a separate follow-up.

## Implementation notes

The four phases share one development workspace and will be published as an ordered review stack. The actual eligible background paths are a completed subagent returning to its parent and a completed background tool waking its conversation. The general background runner has no additional user-facing caller to opt in, so it receives no unused completion option and internal maintenance keeps its existing behavior.

Workflow-manager completion wakes are a separate remaining path. They do not carry the run identity and schedule/quiet ownership needed by this producer. Extending those wakes requires explicit provenance before enabling their alerts, so these changes cover delegated tasks and background commands without claiming all workflow completions.

Background provenance reuses existing task/tool IDs and persisted trigger/result rows. If a successful result is deferred while other work remains pending, later terminal continuations can recover that unread result from the bounded machine-continuation history, including when later work fails or is cancelled. The recipient is the assistant's active Vellum guardian, matching existing reply delivery; task records do not carry a separate launch-time recipient. The resolved principal is included in the notification's existing context payload and checked before local or mobile delivery. Declared completion ownership must validate before delivery and is restricted to recipient-matched desktop/browser and mobile destinations. Recipient-owned background completions stay out of the assistant-wide Home feed and notification bell because those surfaces do not filter by recipient. Their results remain in the source conversation, with scoped desktop/browser and mobile alerts. No database or wire-format migration is introduced.

Completion callbacks use the pipeline's existing permanent deduplication claim. The scheduler waits for active background commands, terminal callbacks for cancelled commands, and queued result continuations before selecting its final result. Failed earlier explicit sends do not count as successful result delivery, but this change does not add a durable retry queue for a completion whose transports all fail. Releasing an already processed event's claim would also duplicate its notification-bell entry, so that delivery-retry redesign is outside this change.

Automated coverage includes recipient-scoped presence and dispatch, silent/quiet rules, browser permission actions, hidden-tab transport, background completion ownership, private result projection, scheduled delivery preservation, and real two-page coordination in Chromium and WebKit. The browser integration exercises IndexedDB transactions and storage with a test delivery callback; it does not prove an OS banner appears. Full assistant and web typechecks have passed. Platform-specific manual acceptance below remains required before closing the ticket.

## Intended experience

Ask the assistant to do something, switch apps or tabs, and receive an operating-system notification when the answer or requested background result is ready. Clicking it opens the correct conversation. Watching that conversation should suppress the redundant alert.

Use the existing notification pipeline, native desktop bridge, browser notification bridge, notification bell, and mobile push adapters. The work connects completion events to these surfaces and fixes the conditions that currently silence or disconnect them.

| Situation | Expected behavior |
| --- | --- |
| Answer finishes while its conversation is visible and attended | Show the answer in the conversation; suppress the redundant completion banner |
| Answer finishes while another conversation is open | Notify and link to the conversation containing the answer |
| Desktop app is minimized or another app has focus | Notify while the desktop app remains running and connected |
| Browser tab stays open but is hidden for minutes | Keep receiving events and notify when browser/OS permission allows |
| A requested background task completes | Notify once its user-facing result is ready, with a link to that result |
| Scheduled work completes | Reuse the scheduler's result notification and quiet-mode rules |
| Internal maintenance or a watcher with no matching event completes | Preserve its existing quiet behavior |
| Notifications are denied or unavailable | Retain normal conversation/feed behavior; report delivery outcome accurately |
| Tab is closed, discarded, or frozen, or the machine is asleep/offline | No new background-delivery guarantee in this scope; retain normal resume/reconnect recovery |

An alert on a phone and an alert on a computer are separate device deliveries. Avoid duplicates on the same receiving surface; this plan does not introduce an account-wide rule allowing only one device to notify.

## Existing work to preserve

- [#39777](https://github.com/vellum-ai/vellum-assistant/pull/39777) emits unseen user-reply notifications, currently selecting only the `platform` mobile push channel.
- [#42035](https://github.com/vellum-ai/vellum-assistant/pull/42035) provides Electron window attention and conversation-scoped presence, including keeping the desktop event stream open while minimized.
- [#42499](https://github.com/vellum-ai/vellum-assistant/pull/42499) mirrors reply notifications into the notification bell.
- [#41916](https://github.com/vellum-ai/vellum-assistant/pull/41916) provides scheduled-result notifications. The scheduler waits for delegated work, skips quiet schedules, and avoids a second notification when the run already delivered its result.
- [#43092](https://github.com/vellum-ai/vellum-assistant/pull/43092) makes the shared web client honor `silent`. Ordinary completion notifications cannot banner merely by adding a delivery channel.
- `conversation-pairing.ts` already prevents a `chat.assistant_reply` preview from being appended as a duplicate transcript message. Keep that behavior.

Evidence comes from code and PR review. It does not establish end-to-end device behavior or the version installed by any particular user.

The checked items below record implementation. The final device acceptance checklist remains pending.

## Phase 1: Connect completion events to desktop and browser alerts

**Outcome:** a completed unseen answer reaches the existing desktop/browser system notification bridge as an alert.

Primary files: `assistant/src/notifications/decision-engine.ts`, `adapters/macos.ts`, `broadcaster.ts`, `destination-resolver.ts`, `conversation-pairing.ts`, and `clients/web/src/hooks/use-notification-intent-sync.ts`.

- [x] Route eligible `chat.assistant_reply` events to both `vellum` and `platform`, intersected with available channels. A self-hosted installation without mobile push must still deliver locally.
- [x] Define one server-owned local-banner policy for eligible completion events. A selected user-reply or non-quiet scheduled-result notification may banner even at medium urgency. Preserve the current silent behavior of unrelated low/medium notifications and all explicitly quiet work.
- [x] Keep urgency separate from presentation: do not mark ordinary completions high/critical merely to force a banner. Resolve presentation once and preserve the existing `notification_intent.silent` client contract. The client must continue honoring `silent: true`.
- [x] Extend that policy to the explicitly user-facing background completions introduced in phase 4. Do not enable every existing `activity.complete` event indiscriminately; skill maintenance also uses that event.
- [x] Target completion intents to the intended authenticated recipient before sending their title/body. Reuse destination identity and event-hub targeting. Widening from owner-scoped mobile push to a local broadcast must not expose reply previews to another connected principal. Missing recipient identity must not fall back to an unrestricted broadcast.
- [x] Preserve source-conversation deep links, sender/avatar identity, existing feed entries, and the reply-preview no-append rule. Do not create a new chat just to host an alert.
- [x] Reuse mobile remote/local push deduplication and delivery acknowledgements. Distinguish a handled or suppressed event from proof that the OS displayed a banner.

Acceptance: qualifying replies and scheduled results can reach desktop/browser banners; unrelated silent events remain silent; local-only installations work; notification clicks open the correct assistant and conversation; no duplicate transcript preview or unauthorized recipient delivery appears.

Tests: notification decision engine, Vellum adapter, broadcaster, conversation pairing, notification-intent hook, and native remote/local deduplication. Include the current tests that explicitly require platform-only reply routing and update their contract with the implementation.

## Phase 2: Suppress only when the relevant conversation is attended

**Outcome:** using another app no longer prevents the completion alert.

Primary files: `assistant/src/notifications/assistant-reply-producer.ts`, `resolve-visible-in-source.ts`, `assistant/src/runtime/web-presence.ts`, `clients/web/src/hooks/use-web-presence-report.ts`, and `clients/web/src/runtime/window-attention.ts`.

- [x] Remove whole-computer attendance from the reply producer's `visibleInSourceNow` decision. Keep desktop attendance available to other consumers that actually need that fact.
- [x] Reuse one conversation-scoped presence read for completion producers, including the resolved recipient principal. Consolidate duplicated presence/error handling while preserving the existing feature-flag semantics.
- [x] Use Electron's authoritative per-window focus/visibility/minimize state. For desktop browsers, require visibility and window focus for completion-attention reporting so a visible browser window behind another app does not imply the user is attending the conversation. Audit other consumers before changing a shared visibility helper; keep visibility and attention as separate facts where needed.
- [x] Send presence changes promptly on focus, blur, navigation, minimize, and restore through the existing event bus. A second attended window showing the same conversation should still suppress a redundant alert.
- [x] Treat stale, disconnected, missing, or failed presence reads as unknown/away. Do not use a timed grace period after leaving as proof that the reply is still on screen.
- [x] Keep the latest-reply unseen check and eligibility exclusions for private text, voice/channel delivery, and unrelated automated prompts. Do not suppress approval/question cards at the producer: those cards are themselves the prompt.

Acceptance: active conversation suppresses; another conversation, another app, minimize, or stale presence allows delivery. Another principal's presence cannot suppress the intended recipient's alert. Phone-originated requests viewed on desktop retain appropriate suppression.

Tests: `assistant-reply-producer.test.ts`, runtime web/desktop presence tests, `use-web-presence-report.test.tsx`, window-attention tests, and notification-intent focus tests. Cover both main and pop-out windows, lock/unlock, and suspend/resume.

## Phase 3: Keep open browser tabs able to receive notifications

**Outcome:** switching tabs for longer than five seconds does not disconnect notification delivery.

Primary files: `clients/web/src/assistant/sse-service.ts`, `runtime/notifications.ts`, notification-intent sync, runtime lifecycle event sources, and the existing notification settings surface.

- [x] Replace the desktop-browser five-second hidden teardown with a host-aware policy that keeps its existing assistant event stream open while the tab remains alive. Retain the current native-mobile lifecycle behavior and Electron exception.
- [x] Keep background rendering and unrelated expensive work paused. Keeping the event transport connected must not resume cameras, capture, or foreground-only effects.
- [x] Preserve assistant/account switch cleanup, logout cleanup, reconnect backoff, and resume reconciliation. Hidden-tab state must continue reporting away even though the connection stays alive. Do not create a second parallel notification stream.
- [x] Add an explicit browser Enable notifications action so permission can be granted before background delivery is needed. The existing bridge first requests permission when an event arrives, and the current Notifications settings page redirects every non-Android host. Extend that page and its navigation gating with a browser permission card while preserving the Android settings card. Keep denied/default/unsupported states distinct, support an explicit retry after an unanswered prompt, avoid automatic repeated prompts, and use localized copy and existing design components.
- [x] Centralize browser per-signal delivery coordination so two tabs on the same account/assistant do not both post the same event. Use an atomic same-origin claim with bounded lifetime and release on failed delivery; scope its identity to account, assistant, and correlation/delivery ID. Check for an existing coordination utility before adding one. Keep ownership/coordination outside React components.
- [x] Preserve Electron's main-process deduplication and mobile's remote/local ownership. Verify another tab receiving an event does not turn a failed local post into an inaccurate success receipt.
- [x] Document that browser/OS freezing, discarding, closing, and offline periods can still stop live delivery. Reconnection should restore current conversation/feed state without replaying a burst of obsolete banners.

Acceptance: hidden-tab notification delivery works after 5 seconds, 1 minute, and 5 minutes in the tested browsers. Two open tabs produce one browser banner per event. Denied permission, reconnect, logout, and assistant switching behave correctly. Mobile suspension behavior remains covered by its existing tests.

Tests: `sse-service.test.ts`, lifecycle event-source tests, notification permission tests, notification-intent hook tests, and a two-tab integration test. Manual browser checks should include Chrome/Edge, Firefox, and Safari where available; record actual coverage and limitations.

## Phase 4: Give user-facing background work a completion owner

**Outcome:** requested asynchronous work announces its completed result once, without announcing every internal job.

Primary files: `assistant/src/runtime/background-job-runner.ts`, `notifications/schedule-result-producer.ts`, `schedule/scheduler.ts`, `daemon/conversation-turn-finalize.ts`, and the background task/subagent parent-continuation paths.

The general runner's current callers include schedules, watchers, heartbeat, sequences, and memory work. A blanket success notification in that runner would generate unwanted alerts and would still miss subagent/task continuations that use another path.

| Work owner | Completion responsibility |
| --- | --- |
| Ordinary user conversation | Existing reply producer, connected in phase 1 |
| Scheduled run, including its delegated work | Existing schedule-result producer; respect quiet and explicit delivery |
| User-requested asynchronous work returning to a parent chat | Parent's finalized user-facing result, correlated to the originating work |
| Explicit user-facing job using the general runner | Opt-in completion delivery after its result is persisted and complete |
| Memory, heartbeat, watcher ticks, sequence steps | Existing assistant-authored notification decisions; no blanket success alert |
| Silent forks, advisor work, live-voice delivery | Preserve current delivery ownership and silence rules |

- [x] Trace actual background task and subagent terminal events through the parent continuation. Record which producer owns each user-facing result. A hidden/scripted kickoff must not by itself exclude a real user-requested completion, and internal wake text must never become notification copy.
- [x] Introduce a typed, explicit completion context for eligible work: originating recipient/conversation, stable task or run identifier, and result-delivery owner. Reuse existing task/run IDs and `sendResultToUser`/quiet semantics. Do not infer eligibility from job-name strings, elapsed time, or text scoring.
- [x] Add a shared background-result producer through `emitNotificationSignal()` using `activity.complete` and explicit completion provenance. Opt the general runner into it only for user-facing work with that context; wire at least one real eligible launch path, rather than adding an unused option.
- [x] For parent continuations, notify after the assistant produces the final user-facing result. Do not add an OS alert at every child terminal event or relax the reply producer's automated-message exclusions globally.
- [x] Reuse the scheduler's result extraction and already-delivered checks by extracting shared behavior on the second use. Preserve the scheduler's existing semantics. Inspect delivery outcomes: a failed attempt must not be mistaken for successful result delivery; an explicit quiet decision must remain quiet.
- [x] Make the completion producer idempotent using stable run/result identity and the existing event/delivery records. Cover repeated callbacks, retry, and restart recovery. The same result must not alert from both the parent and a child/scheduler path.
- [x] Wait for the owning work's terminal result before claiming completion. Do not emit success for errors, timeouts, cancellation, empty/private-only output, or a parent turn that merely launched work still running.
- [x] Keep result persistence ahead of notification delivery so its link is immediately usable. Resolve presence only where that conversation already renders the same result. A worker process without access to live presence must not guess that the user is watching.
- [x] For any new durable completion provenance, include an append-only, idempotent migration and explicit legacy defaults. Do not reinterpret old internal jobs as user-requested work or replace existing storage formats silently.

Acceptance: a real user-requested background task produces one usable completion alert after its final result exists, including when its result arrives through a parent continuation. Scheduled runs, explicitly delivered results, quiet work, internal maintenance, failures, and retries retain their intended behavior.

Tests: focused background-runner, new shared result-producer, schedule-result, scheduler/delegated-work, parent-continuation, and turn-finalization cases. Include a realistic user request that delegates work, returns early, and later receives a final result while the app is unattended.

## Landing order and verification

Use four logical PRs, all linked with `Part of JARVIS-1578` until the full behavior is verified. Recommended landing order: **phase 2, phase 1, phase 3, phase 4**. Phase 2 supplies correct attention handling before delivery is widened; phase 4 reuses the completed delivery policy. Each PR includes its own relevant tests and documentation.

Preserve the existing wire contract where possible. If a new wire capability is required, land the assistant side first, regenerate OpenAPI/client artifacts from committed schemas, and add the web backward-compatibility gate using the actual first supporting build. Test new web/old assistant and old web/new assistant combinations. Any rollout flags require the registry/platform companion changes specified in `meta/feature-flags/AGENTS.md`.

Run Bun with `export PATH="$HOME/.bun/bin:$PATH"`. Run explicit relevant test file paths, in separate processes where module mocks require isolation. Never run unscoped `bun test`. Run lint on changed files and the affected package typechecks. Do not count mocked notification calls as proof of an OS banner.

Update `assistant/src/notifications/README.md` for routing, presentation, recipient targeting, and completion ownership; update the relevant web lifecycle/Electron documentation and `ARCHITECTURE.md` for changed data flow. Remove helpers and stale comments made unused by these changes.

Final manual acceptance:

1. On macOS and Windows, start a reply, switch apps, minimize, and open a different conversation. Confirm the expected alert and click destination. Exercise Linux when available.
2. Repeat with an open hidden browser tab for the time intervals above, then repeat with two tabs and a visible but unfocused browser window.
3. Watch the correct conversation and confirm no redundant completion banner; confirm approval/question cards still arrive.
4. Complete a scheduled run and a user-requested background task, including delegated work. Confirm one result alert and no premature completion.
5. Check quiet schedules, internal maintenance, explicit sends, cancellation, denied permission, and a disconnected/reconnected client.
6. Smoke-test iOS and Android to catch duplicate local/remote pushes introduced by adding the `vellum` route.
7. Exercise an unrelated connected principal, account/assistant switches, and pop-out windows to verify targeting and ownership.

Record tested app/server versions and actual devices/browsers. Keep unavailable coverage explicit. Mark the ticket complete only when all four in-scope outcomes pass; a PR merge alone does not prove notification delivery.

## Separate follow-up: closed-tab browser push

Track service-worker-based Web Push, authenticated subscription registration/removal, server push dispatch, click routing, and deduplication against live-tab delivery as a separate effort. Subscription storage and ingress require the existing platform/gateway ownership boundaries and appropriate migrations. This plan adds no claim that closing the tab or quitting the desktop app preserves delivery.
