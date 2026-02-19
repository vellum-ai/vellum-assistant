// @ts-expect-error -- Bun embed: imports raw file content as a string, not supported by TypeScript
import constantsSource from "./constants.ts" with { type: "text" };
// @ts-expect-error -- Bun embed: imports raw file content as a string, not supported by TypeScript
import defaultMainScreenSource from "../components/DefaultMainScreen.tsx" with { type: "text" };

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
