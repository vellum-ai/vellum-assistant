import type {
  WorkspaceFileGetResponse,
  WorkspaceTreeGetResponse,
} from "@/generated/daemon/types.gen";
import type { SeedQueryCache } from "@/lib/story-query-cache";
import { workspaceTreeQueryOptions } from "@/lib/workspace-tree-query";

import { groupEntriesByDirectory } from "./utils/build-workspace-tree-rows";
import { isHiddenPath } from "./utils/is-hidden-path";
import { workspaceFileRetrieveOptions } from "./utils/workspace-file-query";

export const WORKSPACE_STORY_ASSISTANT_ID = "assistant-1";
export const WORKSPACE_STORY_FILES: WorkspaceFileGetResponse[] = [
  {
    path: "README.md",
    name: "README.md",
    size: 6144,
    mimeType: "text/markdown",
    modifiedAt: "2026-01-01T00:00:00Z",
    isBinary: false,
    content:
      "# Your workspace\n\nA home for your notes, projects, and files.\n\n---\n\n## Getting started\n\n- Browse your files in the title menu.\n- Keep project notes in `notes/`.\n- Switch to source to edit this document.",
  },
  {
    path: "notes/project-plan-with-a-long-descriptive-filename.md",
    name: "project-plan-with-a-long-descriptive-filename.md",
    size: 2048,
    mimeType: "text/markdown",
    modifiedAt: "2026-01-01T00:00:00Z",
    isBinary: false,
    content:
      "# Project plan\n\nKeep the next steps close at hand.\n\n## Next steps\n\n1. Explore the workspace.\n2. Write a first draft.",
  },
  {
    path: "config.json",
    name: "config.json",
    size: 256,
    mimeType: "application/json",
    modifiedAt: "2026-01-01T00:00:00Z",
    isBinary: false,
    content: '{\n  "name": "Example workspace",\n  "theme": "system"\n}',
  },
  {
    path: ".notes.md",
    name: ".notes.md",
    size: 64,
    mimeType: "text/markdown",
    modifiedAt: "2026-01-01T00:00:00Z",
    isBinary: false,
    content:
      "# Hidden notes\n\nA hidden workspace file available in read-only mode.",
  },
];

export const WORKSPACE_STORY_TREE: WorkspaceTreeGetResponse = {
  path: "",
  truncated: false,
  entries: [
    {
      path: "notes",
      name: "notes",
      type: "directory",
      size: null,
      mimeType: null,
      modifiedAt: "2026-01-01T00:00:00Z",
    },
    ...WORKSPACE_STORY_FILES.map(
      ({ content: _content, isBinary: _isBinary, ...file }) => ({
        ...file,
        type: "file" as const,
      }),
    ),
  ],
};

/** Seed the same query keys used by the browser, including reopened folders. */
export const seedWorkspaceStory: SeedQueryCache = (client) => {
  const assistantId = WORKSPACE_STORY_ASSISTANT_ID;
  for (const showHidden of [false, true]) {
    const tree = {
      ...WORKSPACE_STORY_TREE,
      entries: WORKSPACE_STORY_TREE.entries.filter(
        (entry) => showHidden || !isHiddenPath(entry.path),
      ),
    };
    client.setQueryData(
      workspaceTreeQueryOptions({ assistantId, showHidden, recursive: true })
        .queryKey,
      tree,
    );
    for (const [path, entries] of groupEntriesByDirectory(tree.entries)) {
      for (const includeDirSizes of [false, true]) {
        client.setQueryData(
          workspaceTreeQueryOptions({
            assistantId,
            path,
            showHidden,
            includeDirSizes,
          }).queryKey,
          { path, entries },
        );
      }
    }
    for (const file of WORKSPACE_STORY_FILES) {
      if (!showHidden && isHiddenPath(file.path)) {
        continue;
      }
      client.setQueryData(
        workspaceFileRetrieveOptions({
          path: { assistant_id: assistantId },
          query: { path: file.path, showHidden },
        }).queryKey,
        file,
      );
    }
  }
};
