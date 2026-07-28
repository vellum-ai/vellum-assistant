/**
 * Discord Gateway close-code taxonomy — what to do after the socket closes.
 *
 * Every close funnels into one of three recoveries. The mapping is not the one
 * the official table suggests: its `Reconnect` column means "you may open a new
 * socket", NOT "you may RESUME". 4007 and 4009 are reconnectable but their
 * session is gone, so resuming them fails and costs a round trip.
 *
 * The distinction is load-bearing because IDENTIFY is capped at 1000 per 24h
 * and breaching that cap resets the bot token (see `backoff.ts`). Resuming
 * whenever a session survives is what keeps the identify budget intact, and
 * hard-stopping on fatal codes is what stops a doomed retry from spending it.
 *
 * https://docs.discord.com/developers/topics/opcodes-and-status-codes
 */

export type RecoveryAction =
  /** Session may survive: reconnect to `resume_gateway_url` and send op 6. */
  | "resume"
  /** Session is gone: open a fresh socket and send a new IDENTIFY. */
  | "identify"
  /** Unrecoverable without operator action: stop, do not reconnect. */
  | "fatal";

/** Sessions survive these — resume rather than spend an identify. */
const RESUMABLE = new Set([4000, 4001, 4002, 4005, 4008]);

/**
 * Reconnectable, but the session is invalid — resuming returns op 9 and wastes
 * a round trip. 4003/4007/4009 are the codes the official table's `Reconnect:
 * true` most easily misleads on.
 */
const REQUIRES_FRESH_IDENTIFY = new Set([4003, 4007, 4009]);

/**
 * Never retried. Each needs a human: a replaced token (4004), a corrected
 * IDENTIFY (4013), or a Portal toggle (4014). Retrying loops forever, and a
 * 4004 loop additionally spends the identify budget toward a token reset.
 */
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/**
 * Codes that mean the client sent something wrong. Recoverable, but they are
 * our bug rather than Discord's and should be surfaced, not absorbed by a
 * silent reconnect.
 */
const CLIENT_FAULT = new Set([4001, 4002, 4005]);

/**
 * The code this client closes with when it wants the session preserved.
 * 4000 is Discord's "unknown error" — resumable, and outside the 1000/1001
 * range that tells Discord the client is done with the session.
 *
 * Discord's session-invalidation rule is scoped to closes the *client* sends:
 * closing with 1000 or 1001 invalidates the session, which is why deliberate
 * closes that intend to resume use this code instead. Zombie kills and
 * clock-jump recovery depend on that.
 *
 * A *received* 1000 or 1001 carries no invalidation semantics — it is
 * typically an intermediary or a draining node — so this taxonomy resumes
 * both like any other non-fatal received code. The one deliberate outbound
 * 1000 this client sends is its own shutdown, and that path tears the client
 * down without ever consulting the taxonomy.
 */
export const RESUMABLE_CLOSE_CODE = 4000;

/**
 * Map a close code to its recovery.
 *
 * An absent code covers abnormal closes (1006 and transport-level drops),
 * which are the ordinary case for a dropped network and are resumable.
 *
 * Unknown codes resume rather than identify: a resume against a dead session
 * degrades safely to op 9 and then IDENTIFY, whereas identifying against a
 * live session spends budget that resuming would not have.
 */
export function recoveryActionForCloseCode(
  code: number | undefined,
): RecoveryAction {
  if (code === undefined || code === 1006) {
    return "resume";
  }
  if (FATAL.has(code)) {
    return "fatal";
  }
  if (REQUIRES_FRESH_IDENTIFY.has(code)) {
    return "identify";
  }
  if (RESUMABLE.has(code)) {
    return "resume";
  }
  return "resume";
}

/** Whether a close code means the client sent something malformed. */
export function isClientFaultCloseCode(code: number | undefined): boolean {
  return code !== undefined && CLIENT_FAULT.has(code);
}

/**
 * Operator-facing explanation for a fatal close, or undefined when the code is
 * not fatal. Fatal closes are dead ends until a human acts, so the message
 * names the action rather than the symptom.
 */
export function fatalCloseDiagnostic(
  code: number | undefined,
): string | undefined {
  switch (code) {
    case 4004:
      return "Discord rejected the bot token. Store a fresh token from the Developer Portal; the connection stays down until then.";
    case 4010:
      return "Invalid shard sent in IDENTIFY. This client does not shard — a shard field should not be present.";
    case 4011:
      return "This bot is in too many guilds to connect without sharding.";
    case 4012:
      return "Invalid Gateway API version requested.";
    case 4013:
      return "Malformed intents bitfield in IDENTIFY.";
    case 4014:
      return "Discord refused a privileged intent that is not enabled for this app. Enable it in the Developer Portal, or remove it from the IDENTIFY intents.";
    default:
      return undefined;
  }
}
