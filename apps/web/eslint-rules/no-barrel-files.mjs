/**
 * Custom ESLint rule: no-barrel-files.
 *
 * Bans `index.ts` / `index.tsx` re-export files in app code. Barrel
 * files hide module boundaries behind "magic" re-exports, make
 * refactoring harder (since renames have to trace through the
 * barrel), and are a common vector for circular dependencies. The
 * codebase imports from source files directly.
 *
 * `src/generated/` is exempt — barrels there are emitted by the
 * code generator and we don't hand-edit them.
 *
 * See `apps/web/docs/CONVENTIONS.md` → "No barrel files".
 */
import path from "node:path";

export const noBarrelFiles = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow barrel index.ts/index.tsx files in app code (allowed in generated/).",
    },
    schema: [],
    messages: {
      barrel:
        "Barrel files (index.ts / index.tsx) are not allowed in app code. " +
        "Import from the source file directly. See CONVENTIONS.md → 'No barrel files'.",
    },
  },
  create(context) {
    const filePath = context.filename ?? context.getFilename();
    const basename = path.basename(filePath);
    if (basename !== "index.ts" && basename !== "index.tsx") return {};
    // Exempt generated code.
    const posix = filePath.split(path.sep).join("/");
    if (posix.includes("/src/generated/")) return {};
    return {
      Program(node) {
        context.report({ node, messageId: "barrel" });
      },
    };
  },
};
