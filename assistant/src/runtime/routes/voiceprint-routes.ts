/**
 * Route handlers for contact voice profiles.
 *
 * Enroll a contact's voice from one or more clips, manage the
 * stored profiles, and score an unknown clip against them.
 *
 * These identify, they do not authenticate. A voiceprint is not a
 * secret and cannot prove who is speaking, so no handler here may
 * feed an access decision. See `src/voiceprint/README.md`.
 *
 * IMPORTANT: these must be registered BEFORE `CONTACT_ROUTES` in
 * `index.ts`, because `contacts/:id` there would otherwise shadow
 * `contacts/:id/voiceprints`.
 */

import { z } from "zod";

import {
  AudioTooShortError,
  extractEmbeddings,
} from "../../voiceprint/embedder.js";
import {
  DEFAULT_MATCH_THRESHOLD,
  deleteVoiceprint,
  enrollVoiceprint,
  identifySpeaker,
  listVoiceprintsForContact,
  updateVoiceprintLabel,
  VoiceprintError,
} from "../../voiceprint/voiceprint-store.js";
import { UnsupportedAudioError } from "../../voiceprint/wav.js";
import { decodeWav } from "../../voiceprint/wav.js";
import { ACTOR_PRINCIPALS, type RoutePolicy } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Schemas ───────────────────────────────────────────────

const voiceprintSchema = z.object({
  id: z.string(),
  contactId: z.string(),
  label: z.string().nullable(),
  dim: z.number(),
  modelId: z.string(),
  clipCount: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const matchSchema = z.object({
  contactId: z.string(),
  displayName: z.string(),
  voiceprintId: z.string(),
  score: z.number(),
});

const EnrollBodySchema = z.object({
  clips: z
    .array(z.string())
    .min(1)
    .describe("Base64-encoded WAV clips, at least 1.5s of speech each"),
  label: z.string().nullable().optional(),
});

const IdentifyBodySchema = z.object({
  clip: z.string().describe("Base64-encoded WAV clip"),
  threshold: z.number().min(-1).max(1).optional(),
});

const LabelBodySchema = z.object({
  label: z.string().nullable(),
});

// ── Helpers ───────────────────────────────────────────────

/**
 * Decode base64 WAVs and embed them in a single worker spawn.
 *
 * Audio problems are the caller's fault far more often than
 * ours, so they surface as 400s with the underlying reason
 * rather than as a generic failure.
 */
async function embedBase64Clips(clips: string[]): Promise<Float32Array[]> {
  const decoded = clips.map((base64) => {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(base64, "base64");
    } catch {
      throw new BadRequestError("Clip is not valid base64");
    }
    if (bytes.byteLength === 0) {
      throw new BadRequestError("Clip is empty");
    }
    try {
      return decodeWav(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      );
    } catch (err) {
      if (err instanceof UnsupportedAudioError) {
        throw new BadRequestError(err.message);
      }
      throw err;
    }
  });

  try {
    return await extractEmbeddings(
      decoded.map((audio) => ({
        samples: audio.samples,
        sampleRate: audio.sampleRate,
      })),
    );
  } catch (err) {
    if (err instanceof AudioTooShortError) {
      throw new BadRequestError(err.message);
    }
    throw err;
  }
}

function requireParam(
  params: Record<string, string> | undefined,
  name: string,
): string {
  const value = params?.[name];
  if (!value) {
    throw new BadRequestError(`Missing ${name}`);
  }
  return value;
}

// ── Handlers ──────────────────────────────────────────────

function handleList(contactId: string) {
  return { ok: true, voiceprints: listVoiceprintsForContact(contactId) };
}

async function handleEnroll(contactId: string, body: unknown) {
  const parsed = EnrollBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(`Invalid request body: ${parsed.error.message}`);
  }

  const embeddings = await embedBase64Clips(parsed.data.clips);

  try {
    const voiceprint = enrollVoiceprint({
      contactId,
      embeddings,
      label: parsed.data.label ?? null,
    });
    return { ok: true, voiceprint };
  } catch (err) {
    if (err instanceof VoiceprintError) {
      throw new NotFoundError(err.message);
    }
    throw err;
  }
}

async function handleIdentify(body: unknown) {
  const parsed = IdentifyBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(`Invalid request body: ${parsed.error.message}`);
  }
  const [embedding] = await embedBase64Clips([parsed.data.clip]);
  const result = identifySpeaker(
    embedding!,
    parsed.data.threshold ?? DEFAULT_MATCH_THRESHOLD,
  );
  return { ok: true, ...result };
}

function handleSetLabel(voiceprintId: string, body: unknown) {
  const parsed = LabelBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(`Invalid request body: ${parsed.error.message}`);
  }
  const updated = updateVoiceprintLabel(voiceprintId, parsed.data.label);
  if (!updated) {
    throw new NotFoundError(`No voiceprint with id ${voiceprintId}`);
  }
  return { ok: true, voiceprint: updated };
}

function handleDelete(voiceprintId: string) {
  if (!deleteVoiceprint(voiceprintId)) {
    throw new NotFoundError(`No voiceprint with id ${voiceprintId}`);
  }
  return { ok: true };
}

// ── Routes ────────────────────────────────────────────────

const policy: RoutePolicy = {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ACTOR_PRINCIPALS,
};

const readPolicy: RoutePolicy = {
  requiredScopes: ["settings.read"],
  allowedPrincipalTypes: ACTOR_PRINCIPALS,
};

export const ROUTES: RouteDefinition[] = [
  // Fixed sub-path, so it must precede `contacts/:id/...`.
  {
    operationId: "identify_speaker",
    endpoint: "contacts/voiceprints/identify",
    method: "POST",
    policy: readPolicy,
    summary: "Identify a speaker from a clip",
    description:
      "Score a clip against every enrolled voice profile. Returns the full ranking " +
      "and the best match if it clears the threshold. This is a perceptual guess, " +
      "never an authorization decision.",
    tags: ["contacts", "voiceprints"],
    requestBody: IdentifyBodySchema,
    responseBody: z.object({
      ok: z.boolean(),
      ranked: z.array(matchSchema),
      best: matchSchema.nullable(),
      margin: z.number().nullable(),
      threshold: z.number(),
    }),
    handler: ({ body }: RouteHandlerArgs) => handleIdentify(body),
  },
  {
    operationId: "set_voiceprint_label",
    endpoint: "contacts/voiceprints/:voiceprintId",
    method: "PATCH",
    policy,
    summary: "Rename a voice profile",
    tags: ["contacts", "voiceprints"],
    requestBody: LabelBodySchema,
    responseBody: z.object({ ok: z.boolean(), voiceprint: voiceprintSchema }),
    handler: ({ pathParams, body }: RouteHandlerArgs) =>
      handleSetLabel(requireParam(pathParams, "voiceprintId"), body),
  },
  {
    operationId: "delete_voiceprint",
    endpoint: "contacts/voiceprints/:voiceprintId",
    method: "DELETE",
    policy,
    summary: "Delete a voice profile",
    tags: ["contacts", "voiceprints"],
    responseBody: z.object({ ok: z.boolean() }),
    handler: ({ pathParams }: RouteHandlerArgs) =>
      handleDelete(requireParam(pathParams, "voiceprintId")),
  },
  {
    operationId: "list_contact_voiceprints",
    endpoint: "contacts/:id/voiceprints",
    method: "GET",
    policy: readPolicy,
    summary: "List a contact's voice profiles",
    tags: ["contacts", "voiceprints"],
    responseBody: z.object({
      ok: z.boolean(),
      voiceprints: z.array(voiceprintSchema),
    }),
    handler: ({ pathParams }: RouteHandlerArgs) =>
      handleList(requireParam(pathParams, "id")),
  },
  {
    operationId: "enroll_contact_voiceprint",
    endpoint: "contacts/:id/voiceprints",
    method: "POST",
    policy,
    summary: "Enroll a contact's voice",
    description:
      "Embed one or more WAV clips and store their average as this contact's voice " +
      "profile, replacing any existing profile for the current model. More clips " +
      "make a more durable profile.",
    tags: ["contacts", "voiceprints"],
    requestBody: EnrollBodySchema,
    responseBody: z.object({ ok: z.boolean(), voiceprint: voiceprintSchema }),
    handler: ({ pathParams, body }: RouteHandlerArgs) =>
      handleEnroll(requireParam(pathParams, "id"), body),
  },
];
