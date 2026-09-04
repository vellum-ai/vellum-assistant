/**
 * Canonical vocabulary for a guardian request's lifecycle status, shared by
 * the gateway that owns the request rows, the daemon that decides and
 * projects them, and the web that renders the projection.
 */
import { z } from "zod";

export const GUARDIAN_REQUEST_STATUS_VALUES = [
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
] as const;
export const GuardianRequestStatusSchema = z.enum(
  GUARDIAN_REQUEST_STATUS_VALUES,
);
export type GuardianRequestStatus = z.infer<typeof GuardianRequestStatusSchema>;
