/**
 * Neutral wire-protocol contracts between the meet-bot (out-of-process
 * container that joins a meeting) and the assistant daemon, plus the
 * native-messaging protocol used inside the bot container between the
 * in-browser extension and the bot process.
 *
 * These files are intentionally free of imports from `assistant/`,
 * `skills/meet-join/bot/`, or any implementation module so that both sides
 * can depend on them without circular references.
 *
 * Three directions:
 *
 * - **Events** — bot → daemon. Transcript chunks, speaker changes,
 *   participant join/leave, inbound chat, lifecycle transitions. See
 *   {@link MeetBotEvent} and {@link MeetBotEventSchema}.
 * - **Commands** — daemon → bot. Send chat, play audio (metadata only —
 *   PCM is delivered out of band), leave, status request. See
 *   {@link MeetBotCommand} and {@link MeetBotCommandSchema}.
 * - **Native messaging** — extension ↔ bot. Lifecycle, meeting telemetry,
 *   diagnostics, and join/leave/send-chat commands carried over Chrome's
 *   native-messaging stdio pipe. See {@link ExtensionToBotMessage} /
 *   {@link ExtensionToBotMessageSchema} and {@link BotToExtensionMessage} /
 *   {@link BotToExtensionMessageSchema}.
 */

export * from "./events.js";
export * from "./commands.js";
export * from "./native-messaging.js";
