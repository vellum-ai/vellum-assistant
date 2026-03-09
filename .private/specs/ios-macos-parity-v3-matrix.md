# iOS/macOS Parity v3 — Capability-Contract Matrix

> Frozen snapshot of every macOS and iOS capability mapped to its real daemon IPC
> message types. Classifications determine which capabilities are in scope for
> the parity v3 milestone and which are deferred.

## Classifications

| Label | Meaning |
|---|---|
| `portable-stable` | Contract is stable and portable as-is to iOS |
| `mobile-adapt-stable` | Contract is stable but UI/UX needs mobile adaptation |
| `desktop-only` | Requires macOS-specific APIs (AX, ScreenCaptureKit, etc.) — not portable |
| `defer-unstable` | Contract is experimental or incomplete — defer to future milestone |

## Capability-Contract Matrix

| # | Capability | macOS Status | iOS Status | Classification | Transport Contract |
|---|---|---|---|---|---|
| 1 | Skills management | Full | Partial (list only) | `portable-stable` | `skills_list`, `skills_search`, `skills_inspect`, `skills_install`, `skills_uninstall`, `skills_enable`, `skills_disable`, `skills_configure`, `skills_draft`, `skills_create`, `skills_check_updates`, `skills_update` |
| 2 | Contacts CRUD | Full | None | `portable-stable` | `contacts` (action: `list` / `get` / `update_channel` / `delete`), `contacts_changed` broadcast |
| 3 | Apps directory | Full | None | `portable-stable` | `apps_list`, `app_open_request`, `app_delete`, `app_update_preview`, `app_history_request`, `share_app_cloud`, `app_preview_request` |
| 4 | Shared apps | Full | None | `mobile-adapt-stable` | `shared_apps_list`, `shared_app_delete`, `fork_shared_app`, `bundle_app`, `open_bundle`, `gallery_list`, `gallery_install` |
| 5 | Documents | Full | None | `portable-stable` | `document_list`, `document_load`, `document_save` |
| 6 | Channels/Integrations config | Full (SettingsChannelsTab) | Partial (IntegrationsSection) | `mobile-adapt-stable` | `integration_connect`, `integration_list` + `contacts` (action: `update_channel`) |
| 7 | Guardian/Trust | Partial | Partial | `mobile-adapt-stable` | `guardian_action_decision`, `guardian_actions_pending_request`, `contacts` (action: `update_channel`, policy) |
| 8 | Models/Services | Full (SettingsAccountTab) | None | `portable-stable` | `model_get`, `model_set`, `identity_get`, `client_settings_update` + `APIKeyManager` (Keychain) |
| 9 | Task Queue UI | None (no panel) | Full tab | `portable-stable` (reverse-parity) | `work_items_list`, `work_item_run_task`, `work_item_preflight`, `work_item_output`, `work_item_cancel`, `work_item_approve_permissions`, `work_item_update`, `work_item_delete`, `tasks_changed`, `work_item_status_changed` |
| 10 | Deep-link send | None | Yes | `portable-stable` (reverse-parity) | `vellum://send?message=...` URL scheme + `DeepLinkManager` |
| 11 | Computer-use loop | macOS only | N/A | `desktop-only` | `cu_observation`, `cu_action`, `cu_session_create` (AX tree, CGEvent, ScreenCaptureKit) |
| 12 | Menu-bar lifecycle/hotkeys | macOS only | N/A | `desktop-only` | `NSStatusItem`, Carbon `RegisterEventHotKey` (no daemon IPC) |
| 13 | Ambient agent (Ride Shotgun) | Full | Full (`AmbientAgentManager`, `RideShotgunSession`) | `portable-stable` (already cross-platform) | `ride_shotgun_start`, `ride_shotgun_stop`, `watch_started`, `ride_shotgun_progress`, `ride_shotgun_result` |
| 14 | Screen recording | macOS only | N/A | `desktop-only` | ScreenCaptureKit (no daemon IPC) |
| 15 | Document editor (inline) | Partial | None | `defer-unstable` | `document_editor_show`, `document_editor_update` |
| 16 | Constellation view | macOS only, experimental | N/A | `defer-unstable` | No stable contract |
| 17 | Subagent detail panel | macOS only | None | `defer-unstable` | `subagent_event`, `subagent_status_changed`, `subagent_detail_request`, `subagent_spawned` |

## Frozen Target Scope

Every `portable-stable` and `mobile-adapt-stable` capability and its target PR
in the parity v3 series:

| # | Capability | Classification | Target PR |
|---|---|---|---|
| 1 | Skills management | `portable-stable` | PR 2 |
| 2 | Contacts CRUD | `portable-stable` | PR 3 |
| 3 | Apps directory | `portable-stable` | PR 4 |
| 4 | Shared apps | `mobile-adapt-stable` | PR 5 |
| 5 | Documents | `portable-stable` | PR 6 |
| 6 | Channels/Integrations config | `mobile-adapt-stable` | PR 7 |
| 7 | Guardian/Trust | `mobile-adapt-stable` | PR 8 |
| 8 | Models/Services | `portable-stable` | PR 9 |
| 9 | Task Queue UI | `portable-stable` (reverse-parity) | PR 10 |
| 10 | Deep-link send | `portable-stable` (reverse-parity) | PR 11 |

## Backlog

Capabilities deferred from the parity v3 milestone:

| # | Capability | Classification | Rationale |
|---|---|---|---|
| 11 | Computer-use loop | `desktop-only` | Requires AX tree, CGEvent, and ScreenCaptureKit — no iOS equivalent APIs |
| 12 | Menu-bar lifecycle/hotkeys | `desktop-only` | NSStatusItem and Carbon hotkey registration are macOS-only system APIs |
| 13 | Ambient agent (Ride Shotgun) | `portable-stable` (already cross-platform) | iOS already implements the full Ride Shotgun flow via `AmbientAgentManager.swift` and `RideShotgunSession.swift`; no parity work needed |
| 14 | Screen recording | `desktop-only` | ScreenCaptureKit has no iOS counterpart for app-level screen capture |
| 15 | Document editor (inline) | `defer-unstable` | Contract (`document_editor_show`, `document_editor_update`) is still partial; inline editing UX not finalized |
| 16 | Constellation view | `defer-unstable` | Experimental feature with no stable IPC contract |
| 17 | Subagent detail panel | `defer-unstable` | Subagent lifecycle messages (`subagent_event`, `subagent_status_changed`) are still evolving |
