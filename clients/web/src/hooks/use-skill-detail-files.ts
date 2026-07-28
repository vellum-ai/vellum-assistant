import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import {
  skillsByIdFilesContentGetOptions,
  skillsByIdFilesGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  SkillsByIdFilesContentGetResponse,
  SkillsByIdFilesGetResponse,
} from "@/generated/daemon/types.gen";

/** A single entry in a skill's file listing, as returned by the daemon. */
export type SkillFileEntry = SkillsByIdFilesGetResponse["files"][number];

/**
 * Resolve the file path that should be active given the current selection.
 *
 * Falls back to the skill's `SKILL.md` entry when nothing is explicitly
 * selected, mirroring the default-file behavior of the desktop skill detail.
 */
export function pickDefaultFilePath(
  fileEntries: SkillFileEntry[],
  selectedPath: string | null,
): string | null {
  return (
    selectedPath ?? fileEntries.find((f) => f.name === "SKILL.md")?.path ?? null
  );
}

/**
 * Shared data hook for browsing a skill's files: lists the entries, tracks the
 * selected file (defaulting to `SKILL.md`), and fetches the active file's
 * content. Shared by the Intelligence skill-detail layouts (desktop + mobile)
 * and the chat skill-detail panel so the files-list → SKILL.md → content
 * query chain exists exactly once.
 *
 * `assistantId` may be `null` while the active assistant is still resolving
 * (the chat panel reads it from a store); both queries stay disabled until it
 * arrives. The `isPending` flags stay `true` through that disabled window —
 * use them where the window should render as loading (the panel) — while the
 * `isLoading` flags only cover active fetches.
 */
export function useSkillDetailFiles(
  assistantId: string | null,
  skillId: string,
) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const filesQuery = useQuery({
    ...skillsByIdFilesGetOptions({
      path: { assistant_id: assistantId ?? "", id: skillId },
    }),
    select: (data) => data ?? null,
    enabled: Boolean(assistantId),
  });

  const fileEntries = useMemo<SkillFileEntry[]>(
    () => filesQuery.data?.files ?? [],
    [filesQuery.data],
  );

  const skillMd = useMemo(
    () => fileEntries.find((f) => f.name === "SKILL.md"),
    [fileEntries],
  );

  const activePath = pickDefaultFilePath(fileEntries, selectedPath);

  const fileContentQuery = useQuery({
    ...skillsByIdFilesContentGetOptions({
      path: { assistant_id: assistantId ?? "", id: skillId },
      query: { path: activePath ?? "" },
    }),
    select: (data): SkillsByIdFilesContentGetResponse | null => data ?? null,
    enabled: Boolean(assistantId && activePath),
  });

  const activeFile = fileEntries.find((f) => f.path === activePath);

  return {
    fileEntries,
    skillMd,
    selectedPath,
    setSelectedPath,
    activePath,
    activeFile,
    isFilesLoading: filesQuery.isLoading,
    isFilesPending: filesQuery.isPending,
    fileContent: fileContentQuery.data?.content ?? null,
    isBinary: Boolean(fileContentQuery.data?.isBinary),
    isContentLoading: fileContentQuery.isLoading,
    isContentPending: fileContentQuery.isPending,
  };
}
