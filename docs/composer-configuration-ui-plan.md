# Composer configuration UI implementation plan

Assessment date: September 29, 2026. Implementation branch: `codex/composer-configuration-ui`.

The UI follows the supplied Composer Config Final handoff, with concise copy that describes the existing permission behavior. The HTML handoff is a design reference, not production code. Its source specifies the layout; the real components are verified in Storybook. The plus menu shows the current settings; the composer has no separate autonomy or model controls.

## User experience

- A single plus button opens attachments, Autonomy, and Model.
- Both settings start as collapsed summary rows with the category first, such as Model · Balanced and Autonomy · Trusted. Expanding either closes the other. The headings keep the selected profile, and each profile uses the same hint in both states.
- The desktop popover is 400px wide while collapsed and 480px while expanded, constrained by the viewport. Attachment access stays above the settings.
- The mobile bottom sheet has Camera, Photos, and Files tiles. Autonomy uses four icon segments; Model uses five outlined favorite cards and More in a three-column grid.
- All models replaces the settings content with Built-in and Custom sections, Back, and New. There is no search field. The list scrolls and fades at the bottom. On mobile, this transition preserves the sheet's height.
- Selecting a model from the full list returns to the expanded Model section and includes it in the five favorites. Existing visible choices keep their order.
- The selected autonomy and model appear in the menu summary rows, with no duplicate controls in the composer or visibility toggle.
- Autonomy choices, including Hands-off, apply directly without an extra confirmation.

## Copy and permissions

| Autonomy  | Hint                                | Existing threshold |
| --------- | ----------------------------------- | ------------------ |
| Locked    | Asks before taking action.          | `none`             |
| Cautious  | Handles low-risk work and edits.    | `low`              |
| Trusted   | Asks before higher-risk actions.    | `medium`           |
| Hands-off | Auto-approves within access limits. | `high`             |

These labels describe existing risk thresholds. Locked does not impose a hard read-only restriction; approved actions can still change things. Cautious can perform low-risk edits. Hands-off retains identity, host-access, operating-system, and capability boundaries. The UI introduces no new enforcement policy and does not reset existing users' thresholds. Permission-controls-v2 paths must not expose thresholds that they do not honor.

| Model     | Hint                             |
| --------- | -------------------------------- |
| Auto      | Picks a model for each task.     |
| Balanced  | Balances speed, depth and cost.  |
| Quality   | More depth. Slower, higher cost. |
| Fast      | Faster, cheaper. Less depth.     |
| Budget    | Lowest cost. May miss details.   |
| Open Beta | Open-source beta. Results vary.  |

Open Beta is a built-in profile with a beta badge. Custom descriptions are preserved, with `Custom · <model>` as the fallback. Hints may wrap for long custom descriptions, translations, or enlarged text rather than clipping important information.

## Existing support and additions

| Area         | Reused support                                                                              | Addition                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Surfaces     | Shared web app and design-library Popover, BottomSheet, Collapsible, SegmentControl, Button | Shared composer settings content, scoped visual tokens matching the dark handoff, and light/velvet theme support |
| Attachments  | Existing camera, photo, file, paste, and upload paths                                       | Combined menu and scoped Cmd/Ctrl+U shortcut; native input lifetime remains outside the overlay                  |
| Model choice | Existing inference profiles, availability checks, Auto routing, and creation flow           | Built-in/custom grouping, five stable favorites, short hints, and the Open Beta display name                     |
| Autonomy     | Existing threshold configuration and conversation overrides                                 | Matching labels and icons, and explicit draft autonomy                                                           |
| Preferences  | Existing user identity and resource invalidation                                            | User-scoped favorites and last-used model/autonomy choices                                                       |

The controls call the existing configuration controller. Native picker inputs stay mounted while the operating system owns selection. Attachment changes preserve cancellation, focus return, and camera/photo handling.

## State and compatibility

`GET/PATCH /v1/composer/settings` uses the authenticated actor principal forwarded by the gateway. Local sessions use existing local-guardian identity resolution. Favorites and last-used choices are stored atomically under `<workspace>/data/composer-preferences/<sha256-principal>.json`. Partial patches preserve omitted fields. This is additive storage and does not change existing conversation or configuration formats.

A real draft snapshots last-used choices once, with assistant defaults as fallback. A draft waits for a confirmed capability result before initialization or sending; a failed initial probe stays pending, while a failed refresh retains any previously confirmed result. The first message carries its selected inference profile and risk threshold. Existing conversations retain their own choices. Writes are serialized by conversation and field, stale responses cannot overwrite a different conversation or login session, and the send control waits for pending settings writes.

Preference writes publish the generic `sync_changed` invalidation tag `assistant:self:composerPreferences`. Clients refetch canonical data, including on reconnect. `healthz.capabilities.composerSettings` gates the additive endpoint and draft-autonomy behavior. Older assistants keep existing-conversation controls and show an update explanation.

## Verification and remaining rollout work

Storybook renders the real shared surfaces for all seven handoff states: desktop collapsed, desktop expanded, desktop All models, mobile collapsed, mobile Autonomy, mobile Model, and mobile All models. Additional examples cover narrow phones, both themes, loading, older assistants, custom favorites, stable selection order, direct Hands-off selection, and closed desktop/mobile composers. Stories open the menu through its trigger and share the app's input-modality tracking. The popover interaction checks pointer and keyboard focus styling; the mobile list interaction checks that the sheet height stays constant.

Focused tests cover section expansion, selection, model grouping, creation, Back/Escape behavior, preference identity isolation, favorites, draft promotion, selection races, session changes, first-message wiring, native picker lifetime, and resource invalidation. Run frontend/backend type checks and the production Storybook build when the relevant code changes.

Physical iOS/Android camera and file dialogs, the software keyboard, and safe-area behavior still need a device pass. No deployment or release is part of this implementation.
