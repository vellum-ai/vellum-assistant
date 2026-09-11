import { z } from "zod";

import { githubSourceSchema } from "../cli/lib/plugin-marketplace.js";
import type { StandardDocuments } from "./standard-definitions.js";

const relativePackagePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.includes(":") &&
      value
        .split("/")
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        ),
    "Expected a clean repository-relative package directory",
  );
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const catalogSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("local") }),
  z.strictObject({
    kind: z.literal("github"),
    repository: githubSourceSchema,
    definitionDigest: digestSchema,
  }),
  z.strictObject({
    kind: z.literal("marketplace"),
    name: z.string().min(1),
    definitionDigest: digestSchema,
  }),
]);

export const mcpCatalogEntrySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  packagePath: relativePackagePath,
  serverKey: z.string().min(1),
  source: catalogSourceSchema,
  displayName: z.string().min(1),
  description: z.string().min(1),
  documentationUrl: z.url({ protocol: /^https$/ }),
  verifiedAt: z.iso.date(),
  verification: z.enum(["documentation-only", "tested"]),
  setup: z.strictObject({
    mode: z.enum(["oauth", "manual"]),
    instructions: z.string().optional(),
  }),
  oauthProvider: z.string().min(1).optional(),
  icon: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
});

export const mcpCatalogIndexSchema = z
  .strictObject({
    version: z.literal(1),
    entries: z.array(mcpCatalogEntrySchema),
  })
  .superRefine((catalog, ctx) => {
    const ids = new Set<string>();
    for (const [index, entry] of catalog.entries.entries()) {
      if (ids.has(entry.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "id"],
          message: "Duplicate catalog ID",
        });
      }
      ids.add(entry.id);
    }
  });

export type McpCatalogEntry = z.infer<typeof mcpCatalogEntrySchema>;
export type McpCatalogIndex = z.infer<typeof mcpCatalogIndexSchema>;
export interface BundledMcpCatalogEntry extends McpCatalogEntry {
  definitionDigest: string;
  documents: StandardDocuments;
  resolvedSource?: z.infer<typeof githubSourceSchema>;
}
export interface BundledMcpCatalog {
  version: 1;
  entries: BundledMcpCatalogEntry[];
}
