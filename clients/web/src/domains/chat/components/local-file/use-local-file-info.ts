/**
 * Data layer for local files referenced from chat markdown.
 *
 * Classification costs one ranged GET: the first 512 bytes answer existence,
 * total size (from `Content-Range`), and content type (magic bytes, with the
 * server's extension-derived type and the filename as fallbacks) without
 * pulling a whole media file across the wire. Components decide what to render
 * from the resulting {@link LocalFileInfo}, and only then ask for the full
 * bytes through {@link useLocalFileObjectUrl}.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  type LocalFileKind,
  resolveLocalFileType,
  sniffMimeType,
} from "@/domains/chat/utils/mime-sniff";
import { workspaceBasenameOf } from "@/domains/chat/utils/workspace-path-links";
import { workspaceFileContentGet } from "@/generated/daemon/sdk.gen";

export type LocalFileInfo =
  | { status: "loading" }
  | { status: "unavailable"; reason: "missing" | "outside-workspace" | "error" }
  | {
      status: "ready";
      kind: LocalFileKind;
      mime: string | null;
      sizeBytes: number | null;
      workspacePath: string;
      filename: string;
    };

/** Enough for every signature we sniff, and cheap on a large file. */
const HEAD_BYTES = 512;
const HEAD_RANGE = `bytes=0-${HEAD_BYTES - 1}`;

/** A file's identity rarely changes mid-conversation. */
const INFO_STALE_TIME_MS = 30_000;

type LocalFileProbe =
  | {
      ok: true;
      kind: LocalFileKind;
      mime: string | null;
      sizeBytes: number | null;
    }
  | { ok: false; reason: "missing" | "error" };

/**
 * Read at most `limit` bytes, then cancel. A server that ignores the `Range`
 * header answers 200 with the whole file, and buffering that to classify it
 * would defeat the point of the probe.
 */
async function readFirstBytes(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!stream) {
    return new Uint8Array(0);
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value && value.byteLength > 0) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
  }

  const head = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= head.length) {
      break;
    }
    const slice = chunk.subarray(0, head.length - offset);
    head.set(slice, offset);
    offset += slice.byteLength;
  }
  return head;
}

/** Total size from a 206's `Content-Range`, or a 200's `Content-Length`. */
function totalSizeOf(response: Response): number | null {
  const contentRange = response.headers.get("Content-Range");
  if (contentRange) {
    const total = /\/\s*(\d+)\s*$/.exec(contentRange)?.[1];
    return total ? Number(total) : null;
  }
  const contentLength = response.headers.get("Content-Length");
  if (contentLength && /^\d+$/.test(contentLength.trim())) {
    return Number(contentLength.trim());
  }
  return null;
}

async function probeWorkspaceFile(
  assistantId: string,
  workspacePath: string,
): Promise<LocalFileProbe> {
  try {
    const { data, error, response } = await workspaceFileContentGet({
      path: { assistant_id: assistantId },
      query: { path: workspacePath },
      headers: { Range: HEAD_RANGE },
      parseAs: "stream",
      throwOnError: false,
    });

    if (error || !response?.ok) {
      return {
        ok: false,
        reason: response?.status === 404 ? "missing" : "error",
      };
    }

    // `parseAs: "stream"` hands back the response body; the generated response
    // type describes the default `blob` parse.
    const body = data as unknown as ReadableStream<Uint8Array> | null;
    const headBytes = await readFirstBytes(body, HEAD_BYTES);
    const { mime, kind } = resolveLocalFileType({
      sniffedMime: sniffMimeType(headBytes),
      serverMime: response.headers.get("Content-Type"),
      filename: workspaceBasenameOf(workspacePath),
    });
    return { ok: true, kind, mime, sizeBytes: totalSizeOf(response) };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/**
 * Cache key of the ranged classification probe. Exported so a surface that
 * knows the file changed underneath it (a save written through to disk) can
 * invalidate the probe without restating the key shape.
 */
export function localFileInfoQueryKey(
  workspacePath: string | null,
  assistantId?: string,
) {
  return ["local-file-info", assistantId ?? null, workspacePath] as const;
}

/** Cache key of the full-bytes read, the counterpart to the probe's key. */
export function localFileBlobQueryKey(
  workspacePath: string | null,
  assistantId?: string,
) {
  return ["local-file-blob", assistantId ?? null, workspacePath] as const;
}

/**
 * Classify a workspace file with a single ranged GET (bytes=0-511): existence,
 * size, and MIME (magic bytes with extension fallback).
 */
export function useLocalFileInfo(
  workspacePath: string | null,
  assistantId?: string,
): LocalFileInfo {
  const canFetch = workspacePath !== null && !!assistantId;

  const query = useQuery({
    queryKey: localFileInfoQueryKey(workspacePath, assistantId),
    queryFn: () => probeWorkspaceFile(assistantId!, workspacePath!),
    enabled: canFetch,
    staleTime: INFO_STALE_TIME_MS,
    retry: false,
  });

  const probe = query.data;
  const isError = query.isError;

  return useMemo<LocalFileInfo>(() => {
    if (workspacePath === null) {
      return { status: "unavailable", reason: "outside-workspace" };
    }
    if (!probe) {
      // No assistant id yet means the probe has not run, not that the file is
      // gone, so the reference stays in its loading state.
      return isError
        ? { status: "unavailable", reason: "error" }
        : { status: "loading" };
    }
    if (!probe.ok) {
      return { status: "unavailable", reason: probe.reason };
    }
    return {
      status: "ready",
      kind: probe.kind,
      mime: probe.mime,
      sizeBytes: probe.sizeBytes,
      workspacePath,
      filename: workspaceBasenameOf(workspacePath),
    };
  }, [workspacePath, probe, isError]);
}

/**
 * Query options for the full bytes of a workspace file, shared by every
 * surface that needs them (inline media embeds, the read-only file preview) so
 * one file is fetched once however many surfaces show it.
 *
 * `enabled` is left to the caller: the key tolerates a missing assistant id so
 * the options can be built before one is known.
 */
export function workspaceFileBlobQuery(
  workspacePath: string | null,
  assistantId?: string,
) {
  return {
    queryKey: localFileBlobQueryKey(workspacePath, assistantId),
    queryFn: async (): Promise<Blob> => {
      const { data, error } = await workspaceFileContentGet({
        path: { assistant_id: assistantId! },
        query: { path: workspacePath! },
        parseAs: "blob",
        throwOnError: false,
      });
      if (error || !(data instanceof Blob)) {
        throw new Error("Failed to load workspace file");
      }
      return data;
    },
    // A workspace file's bytes are re-read by opening it again, never by a
    // background refetch behind an embed the user is already watching.
    staleTime: Infinity,
    retry: false,
  };
}

/**
 * Object URL for bytes already in hand, re-wrapped so the URL carries the
 * classified MIME type rather than the server's extension guess. Revoked on
 * unmount and whenever the blob or the type changes, so a surface that swaps
 * files never leaks the previous one.
 */
export function useBlobObjectUrl(
  blob: Blob | undefined,
  mime: string | null,
): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const typed = new Blob([blob], { type: mime ?? undefined });
    const objectUrl = URL.createObjectURL(typed);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [blob, mime]);

  return url;
}

/**
 * Full bytes of a workspace file as an object URL, for surfaces that fetch the
 * file themselves. Surfaces that already hold the bytes use
 * {@link useBlobObjectUrl} directly.
 */
export function useLocalFileObjectUrl(args: {
  workspacePath: string | null;
  mime: string | null;
  enabled: boolean;
  assistantId?: string;
}): { url: string | null; isError: boolean } {
  const { workspacePath, mime, enabled, assistantId } = args;
  const canFetch = enabled && workspacePath !== null && !!assistantId;

  const { data: blob, isError } = useQuery({
    ...workspaceFileBlobQuery(workspacePath, assistantId),
    enabled: canFetch,
  });

  return { url: useBlobObjectUrl(blob, mime), isError };
}
