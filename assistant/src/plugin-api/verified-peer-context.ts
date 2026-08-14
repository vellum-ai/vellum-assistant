import { z } from "zod";

const BOUNDED_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const OPERATION_KIND_PATTERN =
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*(?:\.[a-z0-9]+)*$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

export const PeerOperationKindSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(OPERATION_KIND_PATTERN);

const VerifiedPeerOperationSchema = z
  .object({
    id: z.string().min(1).max(128).regex(BOUNDED_IDENTIFIER),
    kind: PeerOperationKindSchema,
    payloadHash: z.string().regex(SHA256_DIGEST),
  })
  .strict();

/**
 * Host-verified peer metadata attached to one inbound plugin operation.
 * External assistant IDs, endpoints, credentials, keys, and signatures are
 * deliberately absent from this contract.
 */
export const VerifiedPeerOperationContextSchema = z
  .object({
    peerId: z.string().min(1).max(128).regex(BOUNDED_IDENTIFIER),
    generation: z.string().min(1).max(128).regex(BOUNDED_IDENTIFIER),
    operation: VerifiedPeerOperationSchema,
  })
  .strict();

export type VerifiedPeerOperationContext = Readonly<
  z.infer<typeof VerifiedPeerOperationContextSchema>
>;

export function parseVerifiedPeerOperationContext(
  value: unknown,
): VerifiedPeerOperationContext {
  return VerifiedPeerOperationContextSchema.parse(value);
}
