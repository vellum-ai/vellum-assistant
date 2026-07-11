import { z } from "zod";

export const RepoPathSchema = z.union([
  z
    .string()
    .describe("Absolute path to a repo checkout — uses default include dirs."),
  z
    .object({
      path: z.string().describe("Absolute path to a repo checkout."),
      includeDirs: z
        .array(z.string())
        .optional()
        .describe(
          "Override the default include dirs for this repo (e.g. ['web/src', 'vembda/src'] for vellum-assistant-platform).",
        ),
    })
    .describe("Repo path with per-repo include-dir override."),
]);

export const CodeGraphConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Whether the AST-based code knowledge graph is built and kept in sync. Safe to leave on: it no-ops when no local repo checkout is detected.",
      ),
    repoPaths: z
      .array(RepoPathSchema)
      .default([])
      .describe(
        "Explicit paths to local repo checkouts to index. Each entry is either a plain string (uses default include dirs) or an object with a path and optional includeDirs override. Empty means auto-detect.",
      ),
    autoWatch: z
      .boolean()
      .default(true)
      .describe(
        "Whether to run a live filesystem watcher that incrementally re-indexes changed source files.",
      ),
  })
  .describe(
    "AST-based code knowledge graph — structural nodes/edges index of detected local repo source, separate from PKB's vector-searched markdown.",
  );

export type CodeGraphConfig = z.infer<typeof CodeGraphConfigSchema>;
