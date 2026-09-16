/**
 * Discord's admission-drop log. Every reason Discord produces is a shared
 * room-admission reason, so its severity table is the shared one; the policy
 * (one promoted line per reason and channel, repeats at debug) is
 * `channels/admission-drop-log.ts`.
 */

import { AdmissionDropLog } from "../channels/admission-drop-log.js";
import {
  ROOM_ADMISSION_DROP_LOG_SEVERITY,
  type RoomAdmissionDropReason,
} from "../channels/room-admission.js";

export function createDiscordAdmissionDropLog(): AdmissionDropLog<RoomAdmissionDropReason> {
  return new AdmissionDropLog(ROOM_ADMISSION_DROP_LOG_SEVERITY);
}
