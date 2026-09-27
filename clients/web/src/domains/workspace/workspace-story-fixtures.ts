import type { QueryClient } from "@tanstack/react-query";

import type {
  WorkspaceFileGetResponse,
  WorkspaceTreeGetResponse,
} from "@/generated/daemon/types.gen";
import {
  fixtureNotFound,
  type StoryFetchHandler,
} from "@/lib/stub-client-fetch";
import { workspaceTreeQueryOptions } from "@/lib/workspace-tree-query";
import { workspaceBasenameOf } from "@/utils/workspace-path-links";

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
      "# Your workspace\n\nA home for your notes, projects, and files.\n\n---\n\n## Getting started\n\n- Browse your files in the file menu.\n- Keep project notes in `notes/`.\n- Switch to source to edit this document.",
  },
  {
    path: "notes/projects/example/project-plan-with-a-long-descriptive-filename.md",
    name: "project-plan-with-a-long-descriptive-filename.md",
    size: 2048,
    mimeType: "text/markdown",
    modifiedAt: "2026-01-01T00:00:00Z",
    isBinary: false,
    content:
      "# Project plan\n\nKeep the next steps close at hand.\n\n## Next steps\n\n1. Explore the workspace.\n2. Write a first draft.",
  },
  {
    path: "tools/workspace-ask.sh",
    name: "workspace-ask.sh",
    size: 192,
    mimeType: "application/x-sh",
    modifiedAt: "2026-01-01T00:00:00Z",
    isBinary: false,
    content:
      '#!/bin/sh\n\n# List the current project files.\nprintf "Workspace files\\n"\nls -1\n',
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

const WORKSPACE_STORY_BINARY_FILES: Omit<
  WorkspaceFileGetResponse,
  "content"
>[] = [
  {
    path: "assets/sample.svg",
    name: "sample.svg",
    size: 240,
    mimeType: "image/svg+xml",
    modifiedAt: "2026-01-01T00:00:00Z",
    isBinary: true,
  },
  {
    path: "exports/archive.zip",
    name: "archive.zip",
    size: 22,
    mimeType: "application/zip",
    modifiedAt: "2026-01-01T00:00:00Z",
    isBinary: true,
  },
];

const WORKSPACE_STORY_IMAGE = new Blob(
  [
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#dce8e2"/><circle cx="320" cy="200" r="120" fill="#8bb29c"/><circle cx="320" cy="200" r="60" fill="#426d58"/></svg>',
  ],
  { type: "image/svg+xml" },
);

/** Serve binary metadata at the API boundary, including its null content. */
export const workspaceStoryBinaryFetch: StoryFetchHandler = (request) => {
  const url = new URL(request.url);
  const file = WORKSPACE_STORY_BINARY_FILES.find(
    ({ path }) => path === url.searchParams.get("path"),
  );
  if (!file) {
    return fixtureNotFound();
  }
  if (url.pathname.endsWith("/workspace/file")) {
    return Response.json({ ...file, content: null });
  }
  if (url.pathname.endsWith("/workspace/file/content")) {
    return file.mimeType === "image/svg+xml"
      ? new Response(WORKSPACE_STORY_IMAGE)
      : new Response(new Uint8Array([80, 75, 5, 6, ...Array(18).fill(0)]), {
          headers: { "Content-Type": "application/zip" },
        });
  }
  return fixtureNotFound();
};

export const WORKSPACE_STORY_TREE: WorkspaceTreeGetResponse = {
  path: "",
  truncated: false,
  entries: [
    ...[
      "assets",
      "exports",
      "notes",
      "notes/projects",
      "notes/projects/example",
      "tools",
    ].map((path) => ({
      path,
      name: workspaceBasenameOf(path),
      type: "directory" as const,
      size: null,
      mimeType: null,
      modifiedAt: "2026-01-01T00:00:00Z",
    })),
    ...[...WORKSPACE_STORY_FILES, ...WORKSPACE_STORY_BINARY_FILES].map(
      ({ path, name, size, mimeType, modifiedAt }) => ({
        path,
        name,
        size,
        mimeType,
        modifiedAt,
        type: "file" as const,
      }),
    ),
  ],
};

/** Seed the same query keys used by the browser, including reopened folders. */
export function seedWorkspaceStory(
  client: QueryClient,
  { omitFileContents = [] }: { omitFileContents?: string[] } = {},
) {
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
      if (
        (!showHidden && isHiddenPath(file.path)) ||
        omitFileContents.includes(file.path)
      ) {
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
    client.setQueryData(
      [
        "assistantsWorkspaceFileContentRetrieve",
        { assistantId, path: "assets/sample.svg", showHidden },
      ],
      WORKSPACE_STORY_IMAGE,
    );
  }
}
