/**
 * ServerMessage — the outbound wire-shape for daemon-to-client events.
 *
 * This is the neutral wire-level definition used by skills via the
 * `SkillHost` contract. Skills treat `ServerMessage` as an opaque
 * discriminated union keyed on `type`, passing values through to the
 * host's event hub without narrowing on specific variants.
 *
 * The authoritative in-process `ServerMessage` with its fully typed
 * per-domain discriminants still lives in
 * `assistant/src/daemon/message-protocol.ts`. The two shapes are
 * structurally compatible: every variant of the detailed union is
 * assignable to this opaque wire shape, which is all the skill-host
 * contract layer requires.
 *
 * Moving the fully typed discriminated union into this package would
 * require relocating `assistant/src/daemon/message-types/` and its
 * cross-file type dependencies (`channels/types.ts`,
 * `skills/skillssh-registry.ts`, `runtime/guardian-decision-types.ts`,
 * `gallery/gallery-manifest.ts`). That is out of scope for PR 3 of the
 * skill-isolation plan and is tracked for later iteration.
 */

/**
 * Opaque wire-level server message. Has a string `type` discriminant
 * and an arbitrary payload. Skills should cast to this via
 * `as ServerMessage` when publishing events they construct themselves.
 */
export interface ServerMessage {
  type: string;
  [key: string]: unknown;
}
