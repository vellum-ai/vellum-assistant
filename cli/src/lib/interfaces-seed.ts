import { readFileSync } from "fs";
import { join } from "path";

function inlineLocalImports(source: string, constantsSource: string): string {
  return source
    .replace(/import\s*\{[^}]*\}\s*from\s*["'][^"']*\/constants["'];?\s*\n/, constantsSource + "\n")
    .replace(/import\s*\{[^}]*\}\s*from\s*["']path["'];?\s*\n/, "");
}

export function buildInterfacesSeed(): string {
  const constantsSource = readFileSync(join(import.meta.dir, "constants.ts"), "utf-8");
  const defaultMainScreenSource = readFileSync(join(import.meta.dir, "..", "components", "DefaultMainScreen.tsx"), "utf-8");
  const mainWindowSource = inlineLocalImports(defaultMainScreenSource, constantsSource);

  return `
INTERFACES_SEED_DIR="/tmp/interfaces-seed"
mkdir -p "\$INTERFACES_SEED_DIR/tui"
cat > "\$INTERFACES_SEED_DIR/tui/main-window.tsx" << 'INTERFACES_SEED_EOF'
${mainWindowSource}INTERFACES_SEED_EOF
`;
}
