# Target State

This document defines the intended end state for Jarvis so progress can be measured against concrete outcomes.

## Product Outcomes

- The assistant continuously perceives relevant on-device context without overwhelming the user.
- The assistant uses judgment to decide what to remember, surface, or act on.
- The assistant can execute approved host actions reliably with verification and observable lifecycle feedback.
- The assistant speaks and responds with context continuity across voice and typed interaction.
- The assistant builds durable memory about projects, people, and preferences over time.

## Technical Success Criteria

### 1) Perception

- Structured `perception.*` events are produced reliably from supported clients.
- Privacy and sanitization gates are enforced before events are committed to memory or surfaced to the model.
- Perception context retrieval is available to agent flows and live voice contexts.

### 2) Action Reliability

- Action execution follows a standard wrapper lifecycle (precondition, execute, verify, fail/rollback path).
- Plan execution supports durable step state, cancellation, and crash recovery.
- Clients receive consistent lifecycle events for in-flight execution.

### 3) Memory Maturation

- Personal knowledge entities and episodes are written idempotently and reinforced over time.
- Preference signals can be strengthened or contradicted with provenance.
- Retrieval prioritizes relevance and confidence rather than raw recency alone.

### 4) Multi-Surface Consistency

- Daemon, gateway, and client event contracts stay aligned for perception/action/plan flows.
- Local desktop and HUD surfaces expose clear status for active assistant behavior.
- Conversation handoff maintains coherent context across supported interfaces.

### 5) Security Posture

- New capabilities remain default-off behind explicit feature flags when needed.
- Host and identity boundaries remain fail-closed.
- Sensitive raw perception payloads are minimized, scoped, and audited.

## End-State Acceptance Checklist

- A user can ask what they were doing recently and receive a correct, perception-derived answer.
- A multi-step plan can run, recover after interruption, and report lifecycle state accurately.
- Memory outputs show learned preferences and project facts with meaningful confidence/provenance.
- Voice and typed modes share relevant real-time context.
- Security guard tests for capability boundaries and redaction continue to pass.

## Explicit Non-Goals (Current Horizon)

- Expanding broad new capability surfaces before hardening the current Phase 10 spine.
- Relying on unaudited raw data flow across process boundaries.
- Treating roadmap boxes as complete without validation evidence in [`docs/project/validation-log.md`](./validation-log.md).
