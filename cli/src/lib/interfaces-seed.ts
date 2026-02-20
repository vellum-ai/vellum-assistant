// Read source files using Bun.file() with string concatenation (not join())
// so Bun's bundler can statically analyze the paths and embed the files
// in the compiled binary ($bunfs). Files must also be passed via --embed
// in the bun build --compile invocation.

function inlineLocalImports(source: string, constantsSource: string): string {
  return source
    .replace(/import\s*\{[^}]*\}\s*from\s*["'][^"']*\/constants["'];?\s*\n/, constantsSource + "\n")
    .replace(/import\s*\{[^}]*\}\s*from\s*["']path["'];?\s*\n/, "");
}

export async function buildInterfacesSeed(): Promise<string> {
  try {
    const constantsSource = await Bun.file(import.meta.dir + "/constants.ts").text();
    const defaultMainScreenSource = await Bun.file(import.meta.dir + "/../components/DefaultMainScreen.tsx").text();
    const mainWindowSource = inlineLocalImports(defaultMainScreenSource, constantsSource);

    return `
INTERFACES_SEED_DIR="/tmp/interfaces-seed"
mkdir -p "\$INTERFACES_SEED_DIR/tui"
cat > "\$INTERFACES_SEED_DIR/tui/main-window.tsx" << 'INTERFACES_SEED_EOF'
${mainWindowSource}INTERFACES_SEED_EOF
`;
  } catch (err) {
    console.warn("⚠️  Could not embed interfaces seed files (expected in compiled binary without --embed):", (err as Error).message);
    return "# interfaces-seed: skipped (source files not available in compiled binary)";
  }
}
