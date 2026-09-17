import type { ChannelCapabilities } from "../daemon/conversation-runtime-assembly.js";

/**
 * Whether this turn arrived on an external messaging surface (Slack, Telegram,
 * email, a plugin channel) rather than the app itself.
 *
 * `resolveChannelCapabilities` folds every first-party client (macOS, web,
 * iOS, CLI, the HTTP API) onto the `vellum` channel, and a prompt built
 * outside a turn carries no capabilities at all, so those two cases are the
 * app and everything else is a channel the gateway delivers to over a reply
 * callback.
 */
export function isExternalChannelTurn(
  capabilities: ChannelCapabilities | undefined,
): boolean {
  const channel = capabilities?.channel;
  return channel !== undefined && channel !== "vellum";
}

/** The two inputs the delegation section's gate reads. */
export interface DelegationGateInputs {
  /**
   * Whether the turn can actually spawn subagents, read off its resolved
   * tool surface (`canSpawnSubagentsForTurn`). Absent means no.
   */
  canSpawnSubagents?: boolean;
  channelCapabilities?: ChannelCapabilities;
}

/**
 * The delegation section's gate: the turn can spawn AND a subagent's answer
 * would reach whoever asked.
 *
 * Off unless a caller states it can spawn, and the caller that states it
 * derives the answer from the turn's resolved tool surface rather than
 * assuming (`canSpawnSubagentsForTurn`). Guidance about handing work to
 * subagents is worth nothing to a turn that cannot spawn, and worse than
 * nothing when it makes that turn defer work it has to do inline.
 *
 * Off on an external channel for the second reason: a subagent's terminal
 * summary reaches the parent through the conversation's event sink, which an
 * app client reads and a channel does not, so a delegated answer would never
 * be delivered to the person who asked for it.
 *
 * Its own module so the conversation's prompt build and the prompt builder
 * share one derivation: the conversation resolves the state once, hands it to
 * the builder, and keeps it for the wire-surface recorder, so the prompt the
 * provider receives and the state a fork replays are the same value.
 */
export function resolveDelegateIndependentTasks(
  options: DelegationGateInputs | undefined,
): boolean {
  return (
    options?.canSpawnSubagents === true &&
    !isExternalChannelTurn(options?.channelCapabilities)
  );
}
