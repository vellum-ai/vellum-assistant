import { join } from "path";

const constantsSource = await Bun.file(join(import.meta.dir, "constants.ts")).text();
const defaultMainScreenSource = await Bun.file(join(import.meta.dir, "..", "components", "DefaultMainScreen.tsx")).text();

function inlineLocalImports(source: string): string {
  return source
    .replace(/import\s*\{[^}]*\}\s*from\s*["'][^"']*\/constants["'];?\s*\n/, constantsSource + "\n")
    .replace(/import\s*\{[^}]*\}\s*from\s*["']path["'];?\s*\n/, "");
}

export function buildInterfacesSeed(): string {
  const mainWindowSource = inlineLocalImports(defaultMainScreenSource);

  return `
INTERFACES_SEED_DIR="/tmp/interfaces-seed"
mkdir -p "\$INTERFACES_SEED_DIR/tui"
cat > "\$INTERFACES_SEED_DIR/tui/main-window.tsx" << 'INTERFACES_SEED_EOF'
${mainWindowSource}INTERFACES_SEED_EOF
`;
}
