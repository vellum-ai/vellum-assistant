import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import {
  skillsByIdFilesContentGetOptions,
  skillsByIdFilesGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { SkillsByIdFilesContentGetResponse } from "@/generated/daemon/types.gen";
import type { SkillFileEntry } from "@/domains/intelligence/skills/types";

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
 * content. Extracted so multiple layouts (desktop + mobile) can reuse the same
 * query setup without duplication.
 */
export function useSkillDetailFiles(assistantId: string, skillId: string) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const filesQuery = useQuery({
    ...skillsByIdFilesGetOptions({
      path: { assistant_id: assistantId, id: skillId },
    }),
    select: (data) => data ?? null,
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
      path: { assistant_id: assistantId, id: skillId },
      query: { path: activePath ?? "" },
    }),
    select: (data): SkillsByIdFilesContentGetResponse | null => data ?? null,
    enabled: Boolean(activePath),
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
    fileContent: fileContentQuery.data?.content ?? null,
    isBinary: Boolean(fileContentQuery.data?.isBinary),
    isContentLoading: fileContentQuery.isLoading,
  };
}
