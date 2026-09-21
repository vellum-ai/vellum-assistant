import type { AssistantEventEnvelope } from "@vellumai/assistant-api";

/** A minimal stream envelope carrying `seq`, for driving the SSE service. */
export function makeEnvelope(seq: number): AssistantEventEnvelope {
  return {
    id: `evt-${seq}`,
    seq,
    emittedAt: new Date(0).toISOString(),
    message: {
      type: "avatar_updated",
      avatarPath: "/tmp/avatar.png",
    },
  };
}
