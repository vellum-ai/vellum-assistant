/**
 * @vellumai/meet-contracts
 *
 * Neutral wire-protocol contracts between the meet-bot (out-of-process
 * container that joins a meeting) and the assistant daemon.
 *
 * This package is intentionally free of imports from `assistant/`,
 * `skills/meet-join/bot/`, or any implementation module so that both sides
 * can depend on it without circular references.
 *
 * Two directions:
 *
 * - **Events** — bot → daemon. Transcript chunks, speaker changes,
 *   participant join/leave, inbound chat, lifecycle transitions. See
 *   {@link MeetBotEvent} and {@link MeetBotEventSchema}.
 * - **Commands** — daemon → bot. Send chat, play audio (metadata only —
 *   PCM is delivered out of band), leave, status request. See
 *   {@link MeetBotCommand} and {@link MeetBotCommandSchema}.
 */

export * from "./events.js";
export * from "./commands.js";
