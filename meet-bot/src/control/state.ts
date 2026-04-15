/**
 * In-process bot state for the meet-bot control surface.
 *
 * The bot is a single-meeting process, so a module-level mutable singleton
 * is a deliberate (and simple) fit here: the HTTP server, the Playwright
 * driver, and the lifecycle emitter all read and write the same state.
 * No persistence — the process is the source of truth for its own lifetime.
 *
 * External callers should prefer reading via {@link BotState.snapshot} so
 * they receive a frozen copy rather than a live reference.
 */

/** Lifecycle phases the bot can be in. */
export type BotPhase =
  | "booting"
  | "joining"
  | "joined"
  | "leaving"
  | "left"
  | "error";

/**
 * Frozen snapshot of the bot's current state.
 *
 * The shape is deliberately narrow — richer meeting metadata (participants,
 * active speaker, etc.) lives elsewhere. This snapshot is just enough for
 * `/status` and `/health` to answer "where is the bot in its lifecycle?".
 */
export interface BotStateSnapshot {
  readonly meetingId: string | null;
  readonly joinedAt: number | null;
  readonly phase: BotPhase;
}

// ---------------------------------------------------------------------------
// Module-level mutable state.
// ---------------------------------------------------------------------------

let meetingId: string | null = null;
let joinedAt: number | null = null;
let phase: BotPhase = "booting";

/**
 * Singleton accessor for the bot's lifecycle state.
 *
 * Exposed as an object (not a class) so the HTTP server and lifecycle
 * publisher can share the same mutable state without having to thread a
 * specific instance around; tests can still reset it via
 * {@link BotState.__resetForTests}.
 */
export const BotState = {
  /** Transition the bot to a new lifecycle phase. */
  setPhase(next: BotPhase): void {
    phase = next;
    if (next === "joined" && joinedAt === null) {
      joinedAt = Date.now();
    }
  },

  /** Record which meeting the bot is (or was) attached to. */
  setMeeting(id: string | null): void {
    meetingId = id;
  },

  /** Return a frozen copy of the current state. */
  snapshot(): Readonly<BotStateSnapshot> {
    return Object.freeze({ meetingId, joinedAt, phase });
  },

  /**
   * Reset the singleton to its initial values.
   *
   * Intended for tests only — production code should never need this.
   */
  __resetForTests(): void {
    meetingId = null;
    joinedAt = null;
    phase = "booting";
  },
};
