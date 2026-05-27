import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveBundledDir } from "../util/bundled-asset.js";
import { stripCommentLines } from "../util/strip-comment-lines.js";

/**
 * Returns true when the prompt file content is still the unmodified template
 * shipped with the daemon.  Comment-strips BOTH the workspace content and the
 * bundled template source before comparing, so the check stays accurate even
 * if templates are edited in future releases — and regardless of whether the
 * caller passes raw or already-stripped content.  Most callers pre-strip via
 * `readPromptFile`/`stripCommentLines`, but the `08-identity` section
 * transform receives the raw workspace body (comment-stripping happens after
 * the transform in `renderSection`); stripping here keeps detection correct
 * for both.  `stripCommentLines` is idempotent, so pre-stripped callers are
 * unaffected.
 *
 * Kept in a leaf module so the bundled section registry can depend on it
 * without forming a cycle through `system-prompt.ts → sections.ts →
 * templates/system-sections.ts`.
 */
export function isTemplateContent(
  content: string | null,
  templateFileName: string,
): boolean {
  if (content == null) return false;
  const templatesDir = resolveBundledDir(
    import.meta.dirname ?? __dirname,
    "templates",
    "templates",
  );
  const templatePath = join(templatesDir, templateFileName);
  if (!existsSync(templatePath)) return false;
  try {
    const templateContent = stripCommentLines(
      readFileSync(templatePath, "utf-8"),
    );
    return stripCommentLines(content) === templateContent;
  } catch {
    return false;
  }
}
