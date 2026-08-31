/**
 * Voice profile operations for a contact.
 *
 * These are daemon routes (the embedding model runs in the daemon),
 * so they go through the generated daemon SDK rather than the
 * gateway one.
 */

import {
  contactsByIdVoiceprintsGet,
  contactsByIdVoiceprintsPost,
  contactsVoiceprintsByVoiceprintIdDelete,
  contactsVoiceprintsIdentifyPost,
} from "@/generated/daemon/sdk.gen";
import type {
  ContactsByIdVoiceprintsGetResponse,
  ContactsVoiceprintsIdentifyPostResponse,
} from "@/generated/daemon/types.gen";
import { ApiError, assertHasResponse } from "@/utils/api-errors";

export type Voiceprint =
  ContactsByIdVoiceprintsGetResponse["voiceprints"][number];
export type IdentifyResult = ContactsVoiceprintsIdentifyPostResponse;

/**
 * Read a File (from a file picker or a recorder) as base64.
 *
 * The routes take base64 WAV in JSON rather than multipart, which
 * keeps the daemon side a plain typed handler. Clips are seconds
 * long, so the ~33% encoding overhead is not worth avoiding.
 */
export async function fileToBase64(file: Blob): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunked so a long clip cannot blow the argument limit of
  // String.fromCharCode with a spread of every byte at once.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function listVoiceprints(
  assistantId: string,
  contactId: string,
): Promise<Voiceprint[]> {
  const { data, error, response } = await contactsByIdVoiceprintsGet({
    path: { assistant_id: assistantId, id: contactId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load voice profiles");
  if (!response.ok || !data) {
    throw new ApiError(response.status, "Failed to load voice profiles");
  }
  return data.voiceprints;
}

export async function enrollVoiceprint(
  assistantId: string,
  contactId: string,
  clips: string[],
  label?: string | null,
): Promise<Voiceprint> {
  const { data, error, response } = await contactsByIdVoiceprintsPost({
    path: { assistant_id: assistantId, id: contactId },
    body: { clips, label: label ?? null },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to enroll voice");
  if (!response.ok || !data?.voiceprint) {
    // The daemon explains audio problems precisely (too short,
    // unsupported encoding), so surface its message rather than
    // a generic one the user cannot act on.
    throw new ApiError(
      response.status,
      extractMessage(error) ?? "Failed to enroll voice",
    );
  }
  return data.voiceprint;
}

export async function deleteVoiceprint(
  assistantId: string,
  voiceprintId: string,
): Promise<void> {
  const { error, response } = await contactsVoiceprintsByVoiceprintIdDelete({
    path: { assistant_id: assistantId, voiceprintId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to delete voice profile");
  if (!response.ok) {
    throw new ApiError(response.status, "Failed to delete voice profile");
  }
}

export async function identifySpeaker(
  assistantId: string,
  clip: string,
): Promise<IdentifyResult> {
  const { data, error, response } = await contactsVoiceprintsIdentifyPost({
    path: { assistant_id: assistantId },
    body: { clip },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to identify speaker");
  if (!response.ok || !data) {
    throw new ApiError(
      response.status,
      extractMessage(error) ?? "Failed to identify speaker",
    );
  }
  return data;
}

function extractMessage(error: unknown): string | undefined {
  if (error && typeof error === "object" && "error" in error) {
    const inner = (error as { error?: unknown }).error;
    if (typeof inner === "string") {
      return inner;
    }
  }
  return undefined;
}
