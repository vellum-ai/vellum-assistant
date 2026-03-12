# Approvals & Guardian Rules

## Approval Flow Resilience

- **Rich delivery failures must degrade gracefully.** If delivering a rich approval prompt (e.g., Telegram inline buttons) fails, fall back to plain text with instructions (e.g., `Reply "yes" to approve`) — never auto-deny.
- **Non-rich channels** (http-api) receive plain-text approval prompts. The conversational approval engine handles free-text responses.
- **Race conditions:** Always check whether a decision has already been resolved before delivering the engine's optimistic reply. If `handleChannelDecision` returns `applied: false`, deliver an "already resolved" notice and return `stale_ignored`.
- **Requester self-cancel:** A requester with a pending guardian approval must be able to cancel their own request (but not self-approve).
- **Unified guardian decision primitive:** All guardian decision paths (callback buttons, conversational engine, requester self-cancel) must route through `applyGuardianDecision()` in `assistant/src/approvals/guardian-decision-primitive.ts`. Do not inline decision logic (approve_always downgrade, approval record updates, grant minting) at individual callsites.

## Guardian Verification Invariant

Guardian verification consumption must be identity-bound to the expected recipient identity. Every outbound verification session stores the expected identity (phone E.164, Telegram user/chat ID), and the consume path rejects attempts where the responding actor's identity does not match.

Conversational guardian verification control-plane invocation is guardian-only. Non-guardian and unverified-channel actors cannot invoke channel verification endpoints (`/v1/channel-verification-sessions/*`) conversationally via tools. Enforcement is a deterministic gate in the tool execution layer (`assistant/src/tools/executor.ts`) using actor-role context — only `guardian` and `undefined` (desktop/trusted) actor roles pass. The policy module is at `assistant/src/tools/verification-control-plane-policy.ts`.

## Memory Provenance Invariant

All memory retrieval decisions must consider actor-role provenance. Untrusted actors (non-guardian, unverified_channel) must not receive memory recall results. This invariant is enforced in `indexer.ts` (write gate) and `session-memory.ts` (read gate).

## Guardian Privilege Isolation Invariant

Untrusted actors (`non-guardian`, `unverified_channel`) must never receive privileged host/tool capabilities or privileged conversation context directly.

- Tool execution gate: untrusted actors cannot execute host-target tools or side-effect tools in-band. These actions require guardian-mediated approval flow. Enforcement lives in `assistant/src/tools/tool-approval-handler.ts`.
- History view gate: when loading session history for untrusted actors, only untrusted-provenance messages are included and compacted summaries are suppressed. This prevents replay of guardian-era context after trust downgrades. Enforcement lives in `assistant/src/daemon/session-lifecycle.ts` and actor-scoped reload wiring in `assistant/src/daemon/session.ts`.
