/**
 * `confirmation_request` SSE event.
 *
 * Server → client prompt asking the user to approve or deny a tool
 * invocation that fell outside the auto-approve threshold. Emitted by
 * the confirmation prompter / risk classifier when a tool call needs
 * human review.
 *
 * Resolved by a paired `interaction_resolved` event (`kind:
 * "confirmation"`, `state: "approved" | "rejected" | "cancelled" |
 * "superseded"`) once the user decides, the daemon times out, or a
 * newer user message supersedes the pending request.
 *
 * Required fields are what the prompter always supplies:
 *  - `toolName`, `input` — what the tool will run with
 *  - `riskLevel` — risk-classifier output, used for display only
 *    (kept loose `string` rather than enum — risk grades evolve
 *    independently of the wire and the client renders them as text)
 *  - `allowlistOptions`, `scopeOptions` — radio choices the rule
 *    editor offers when the user picks "always allow"
 *
 * `acpToolKind` and `acpOptions` are present only for ACP (Agent
 * Client Protocol) permission requests forwarded from a sub-agent;
 * `acpOptions.kind` is a strict 4-variant enum because the agent
 * protocol mandates exactly those four shapes.
 *
 * `executionTarget` distinguishes sandbox vs host execution — a strict
 * 2-variant enum because the sandbox switch is binary at the daemon
 * level.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const AllowlistOptionSchema = z.object({
  label: z.string(),
  description: z.string(),
  pattern: z.string(),
});

export type AllowlistOption = z.infer<typeof AllowlistOptionSchema>;

export const ScopeOptionSchema = z.object({
  label: z.string(),
  scope: z.string(),
});

export type ScopeOption = z.infer<typeof ScopeOptionSchema>;

export const DirectoryScopeOptionSchema = z.object({
  label: z.string(),
  scope: z.string(),
});

export type DirectoryScopeOption = z.infer<typeof DirectoryScopeOptionSchema>;

export const ConfirmationDiffSchema = z.object({
  filePath: z.string(),
  oldContent: z.string(),
  newContent: z.string(),
  isNewFile: z.boolean(),
});

export type ConfirmationDiff = z.infer<typeof ConfirmationDiffSchema>;

export const ACPOptionKindSchema = z.enum([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);

export type ACPOptionKind = z.infer<typeof ACPOptionKindSchema>;

export const ACPOptionSchema = z.object({
  optionId: z.string(),
  name: z.string(),
  kind: ACPOptionKindSchema,
});

export type ACPOption = z.infer<typeof ACPOptionSchema>;

export const ConfirmationExecutionTargetSchema = z.enum(["sandbox", "host"]);

export type ConfirmationExecutionTarget = z.infer<
  typeof ConfirmationExecutionTargetSchema
>;

export const ConfirmationRequestEventSchema = z.object({
  type: z.literal("confirmation_request"),
  requestId: z.string(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  riskLevel: z.string(),
  riskReason: z.string().optional(),
  isContainerized: z.boolean().optional(),
  executionTarget: ConfirmationExecutionTargetSchema.optional(),
  allowlistOptions: z.array(AllowlistOptionSchema),
  scopeOptions: z.array(ScopeOptionSchema),
  directoryScopeOptions: z.array(DirectoryScopeOptionSchema).optional(),
  diff: ConfirmationDiffSchema.optional(),
  conversationId: z.string().optional(),
  persistentDecisionsAllowed: z.boolean().optional(),
  toolUseId: z.string().optional(),
  acpToolKind: z.string().optional(),
  acpOptions: z.array(ACPOptionSchema).optional(),
});

export type ConfirmationRequestEvent = z.infer<
  typeof ConfirmationRequestEventSchema
>;
