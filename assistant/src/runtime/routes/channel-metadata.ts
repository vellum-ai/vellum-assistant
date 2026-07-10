import {
  extractImageSourcePaths,
  provenanceFromTrustContext,
} from "../../persistence/conversation-crud.js";

/**
 * Assemble the standard channel metadata object for message persistence.
 *
 * Combines provenance (trust context), channel/interface routing, and
 * optional per-message fields (automated flag, image source paths) into the
 * Record that `addMessage` stores in the `metadata` column.
 *
 * `sourceInterface` may be undefined for routes that don't receive an
 * interface id from the client (e.g. the summarize-up-to management route);
 * the interface keys are omitted in that case.
 */
export function buildChannelMetadata(
  sourceChannel: string,
  sourceInterface: string | undefined,
  opts?: {
    trustContext?: Parameters<typeof provenanceFromTrustContext>[0];
    provenanceOverride?: Record<string, unknown>;
    automated?: boolean;
    attachments?: ReadonlyArray<{
      filename: string;
      mimeType: string;
      filePath?: string;
    }>;
  },
): Record<string, unknown> {
  const provenance =
    opts?.provenanceOverride ?? provenanceFromTrustContext(opts?.trustContext);
  const imageSourcePaths = opts?.attachments
    ? extractImageSourcePaths(opts.attachments)
    : undefined;
  return {
    ...provenance,
    userMessageChannel: sourceChannel,
    assistantMessageChannel: sourceChannel,
    ...(sourceInterface !== undefined
      ? {
          userMessageInterface: sourceInterface,
          assistantMessageInterface: sourceInterface,
        }
      : {}),
    ...(opts?.automated ? { automated: true } : {}),
    ...(imageSourcePaths ? { imageSourcePaths } : {}),
  };
}
