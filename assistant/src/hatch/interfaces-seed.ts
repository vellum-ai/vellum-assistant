import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RESOURCES_DIR = join(import.meta.dir, 'resources');
const CONSTANTS_PATH = join(import.meta.dir, 'constants.ts');

function inlineLocalImports(source: string): string {
  const constantsSource = readFileSync(CONSTANTS_PATH, 'utf-8');

  return source
    .replace(/import\s*\{[^}]*\}\s*from\s*["'][^"']*\/constants["'];?\s*\n/, constantsSource + '\n')
    .replace(/import\s*\{[^}]*\}\s*from\s*["']path["'];?\s*\n/, '');
}

export function buildInterfacesSeed(): string {
  const rawSource = readFileSync(join(RESOURCES_DIR, 'DefaultMainScreen.tsx'), 'utf-8');
  const mainWindowSource = inlineLocalImports(rawSource);

  return `
INTERFACES_SEED_DIR="/tmp/interfaces-seed"
mkdir -p "\\$INTERFACES_SEED_DIR/tui"
cat > "\\$INTERFACES_SEED_DIR/tui/main-window.tsx" << 'INTERFACES_SEED_EOF'
${mainWindowSource}INTERFACES_SEED_EOF
`;
}
