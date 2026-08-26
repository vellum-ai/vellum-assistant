/**
 * Canned access-denial copy and the plugin notice the gateway posts when a
 * plugin inbound delivery clears verification but fails the admission floor.
 *
 * Built-in channels send this reply through the runtime's channel transport.
 * A plugin channel has no such transport: the gateway does not hold the
 * vendor send credentials, so the notice is how the plugin learns it must
 * send the same line itself, without running a turn.
 */

import { z } from "zod";

import { AdmissionPolicySchema } from "./admission-policy-contract.js";
import { TrustClassSchema } from "./trust-verdict-contract.js";

/**
 * Requester-facing reply when access is denied and there is no handshake
 * and no guardian notification. Single source for this line: the runtime
 * ACL composer and the plugin admission-denied notice both send it.
 */
export const ACCESS_DENIED_NOT_APPROVED_REPLY =
  "Sorry, you haven't been approved to message this assistant.";

/**
 * Plugin route the gateway posts the notice to, under
 * `/v1/x/plugins/<plugin>/`. Not a public ingress path.
 */
export const PLUGIN_ADMISSION_DENIED_NOTICE_PATH = "notices/admission-denied";

export const PluginAdmissionDeniedNoticeSchema = z.object({
  reason: z.literal("admission_floor"),
  plugin: z.string().min(1),
  ingressRoute: z.string().min(1),
  admissionPolicy: AdmissionPolicySchema,
  trustClass: TrustClassSchema,
  /** Vendor chat id, without the plugin prefix the gate stores. */
  conversationExternalId: z.string().min(1),
  /** Vendor sender id, without the plugin prefix the gate stores. */
  actorExternalId: z.string().min(1),
  /** Vendor message id, without the plugin prefix the gate stores. */
  externalMessageId: z.string().min(1),
  replyText: z.string().min(1),
});

export type PluginAdmissionDeniedNotice = z.infer<
  typeof PluginAdmissionDeniedNoticeSchema
>;
