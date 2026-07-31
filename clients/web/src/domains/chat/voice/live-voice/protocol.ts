/**
 * Web compatibility exports for the shared live-voice wire contract.
 *
 * Audio capture and playback remain browser-owned. Client-neutral JSON frame
 * shapes, PCM constants, and tolerant server parsing are owned by
 * `@vellumai/service-contracts/live-voice`.
 */

export * from "@vellumai/service-contracts/live-voice";
export { parseLiveVoiceServerFrame as parseServerFrame } from "@vellumai/service-contracts/live-voice";

export type { LiveVoiceClientControlFrame as LiveVoiceClientFrame } from "@vellumai/service-contracts/live-voice";
