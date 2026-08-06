/**
 * Discord Gateway session state and the resume-or-identify decision.
 *
 * Every recovery path — a dropped socket, op 7 RECONNECT, op 9 INVALID_SESSION,
 * a zombie kill, a post-sleep clock jump — ends in the same question: reconnect
 * where, and open with op 6 RESUME or op 2 IDENTIFY? Answering it in one place
 * is what keeps that from becoming a lattice of branches that each get the
 * identify budget slightly wrong.
 *
 * The two URLs are not interchangeable. A resume must go to the
 * `resume_gateway_url` from READY, carrying the same version and encoding
 * params; Discord reports that resumes against the base URL "experience
 * disconnects at a higher rate". An identify goes to the base URL from
 * `GET /gateway/bot`.
 *
 * https://docs.discord.com/developers/events/gateway
 */

/** Gateway API version this client speaks. */
export const GATEWAY_VERSION = "10";

/** Payload encoding. `json` avoids the optional erlpack/zlib dependencies. */
export const GATEWAY_ENCODING = "json";

/**
 * Stamp the version and encoding Discord requires onto a Gateway URL.
 *
 * Both URLs arrive bare — `GET /gateway/bot` returns `wss://gateway.discord.gg`
 * and READY's `resume_gateway_url` is the same shape — and a socket opened
 * without these params is rejected. Applying it here rather than at each call
 * site is what keeps a resume and an identify from ever disagreeing about the
 * version they speak, which Discord treats as a resume failure.
 *
 * Existing params are preserved and the required two are overwritten, so a URL
 * that already carries them is idempotent rather than doubled.
 */
function withGatewayParams(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("v", GATEWAY_VERSION);
  parsed.searchParams.set("encoding", GATEWAY_ENCODING);
  return parsed.toString();
}

/** Where to connect next, and what to send once the socket opens. */
export interface ConnectionPlan {
  url: string;
  action: "resume" | "identify";
}

/** The op 6 RESUME payload data. */
export interface ResumePayload {
  session_id: string;
  seq: number;
}

export class DiscordSessionState {
  private sessionId: string | undefined;
  private resumeGatewayUrl: string | undefined;
  private lastSequence: number | undefined;

  /**
   * `baseGatewayUrl` comes from `GET /gateway/bot` and is the identify target.
   * It stays valid for the client's lifetime; only the resume URL is per-session.
   */
  constructor(private readonly baseGatewayUrl: string) {}

  /**
   * Record a READY dispatch. This is what makes a session resumable — before
   * it, there is nothing to resume to.
   */
  noteReady(sessionId: string, resumeGatewayUrl: string): void {
    this.sessionId = sessionId;
    this.resumeGatewayUrl = resumeGatewayUrl;
  }

  /**
   * Record the sequence number on a received payload.
   *
   * Only non-null values advance it: Discord sends `s: null` on every
   * non-dispatch payload, and letting those overwrite the sequence would make
   * the next resume ask to replay from nowhere. The sequence deliberately
   * survives session invalidation — it is only meaningful alongside a session
   * id, and clearing both together is handled by {@link invalidate}.
   */
  noteSequence(sequence: number | null | undefined): void {
    if (typeof sequence === "number") {
      this.lastSequence = sequence;
    }
  }

  /**
   * Drop the session. Called for op 9 with `d: false`, and for close codes
   * whose session is gone (4003 / 4007 / 4009).
   *
   * The sequence goes with it: a sequence from a dead session is not a valid
   * resume point, and keeping it would make the next resume look legitimate
   * while asking Discord to replay from a stream it no longer has.
   */
  invalidate(): void {
    this.sessionId = undefined;
    this.resumeGatewayUrl = undefined;
    this.lastSequence = undefined;
  }

  /** Whether there is a session to resume — a resume needs all three parts. */
  get canResume(): boolean {
    return (
      this.sessionId !== undefined &&
      this.resumeGatewayUrl !== undefined &&
      this.lastSequence !== undefined
    );
  }

  /**
   * Where to connect and what to open with.
   *
   * Resume is always preferred when possible: it replays missed events and,
   * unlike IDENTIFY, costs nothing against the 1000-per-24h budget whose
   * breach resets the bot token.
   */
  nextConnection(): ConnectionPlan {
    if (this.canResume) {
      // Non-null: `canResume` is exactly the check that these are set.
      return {
        url: withGatewayParams(this.resumeGatewayUrl as string),
        action: "resume",
      };
    }
    return { url: withGatewayParams(this.baseGatewayUrl), action: "identify" };
  }

  /** The op 6 payload, or undefined when there is no session to resume. */
  resumePayload(): ResumePayload | undefined {
    if (!this.canResume) {
      return undefined;
    }
    return {
      session_id: this.sessionId as string,
      seq: this.lastSequence as number,
    };
  }
}
