/**
 * reveal-nonce — per-conversation secret binding reveal-derived authority
 * to the conversation whose tool shell actually executed the reveal.
 *
 * The reveal route's records (plaintext proofs and `--for-chat` mints) are
 * process-global, and the identities a run STAGES are parsed from command
 * text — so with two turns running concurrently, conversation B could
 * quote a reveal command (staging the identity) while conversation A
 * executes a real reveal for the same identity, and B's guard would treat
 * A's record as its own authority. Every caller-visible conversation
 * identifier (`__CONVERSATION_ID`, a body field) is overridable by the
 * command under execution, so the binding must be a value other
 * conversations cannot know.
 *
 * This module holds one random nonce per conversation, created lazily and
 * kept only in daemon memory. The shell tools export it to the tool
 * subprocess as `__REVEAL_NONCE`; the CLI forwards it on reveal calls; the
 * route stamps it onto every record; and the conversation loop accepts
 * only records carrying its own nonce. A quoted/commented-out invocation
 * never reaches the route, so it never produces a record with any nonce.
 * A model can read its own conversation's nonce from the tool env, but
 * spending it requires an actual route call from its own approval-gated
 * tool shell — which is precisely the authority the binding encodes.
 * Another conversation's nonce appears in no transcript, log, or URL;
 * stealing one requires an exfiltration channel between two already-
 * compromised conversations, which defeats any per-conversation binding.
 *
 * Nonces are not persisted: a daemon restart rotates them, which only
 * invalidates records that are themselves turn-scoped and in-memory.
 */

import { randomBytes } from "node:crypto";

const nonces = new Map<string, string>();

/** The secret reveal nonce for a conversation (lazily created). */
export function conversationRevealNonce(conversationId: string): string {
  let nonce = nonces.get(conversationId);
  if (nonce === undefined) {
    nonce = randomBytes(16).toString("hex");
    nonces.set(conversationId, nonce);
  }
  return nonce;
}

/** Test-only: drop all nonces so each test starts unbound. */
export function _resetRevealNoncesForTest(): void {
  nonces.clear();
}
