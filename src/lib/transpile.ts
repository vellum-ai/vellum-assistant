import { transform } from "sucrase";

export function transpileEditorSource(source: string): string {
  const strippedSource = source
    .replace(/^import\s+.*?['"].*?['"];?\s*$/gm, "")
    .replace(/^export\s+default\s+/gm, "")
    .replace(/^export\s+/gm, "");

  const { code } = transform(strippedSource, {
    transforms: ["typescript", "jsx"],
    jsxRuntime: "classic",
    production: true,
  });

  return code;
}
