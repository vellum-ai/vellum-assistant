import { agentMarkdownPathForPage } from "../../src/lib/agent-markdown-paths";
import { SITE_URL } from "../../src/lib/metadata";

/** Title/description for a docs page, emitted to the sidecar metadata index
 *  so llms.txt lists exactly what the mirrors serve without parsing the .md
 *  bodies. */
export interface DocsPageMeta {
  route: string;
  title: string;
  description: string;
}

/** Public markdown URL for a docs route (the `.md`-suffix form advertised to
 *  agents; the Accept-negotiation rewrite serves the same bytes). */
function markdownUrl(route: string): string {
  const path = agentMarkdownPathForPage(route);
  if (!path) {
    throw new Error(`No markdown alternate path for docs route ${route}`);
  }
  return `${SITE_URL}${path}`;
}

export function buildLlmsText(pages: DocsPageMeta[]): string {
  const lines = [
    "# Vellum Docs",
    "",
    "> Vellum is a personal AI assistant that remembers, learns, and takes real action across your apps, files, and communication channels.",
    "",
    "Vellum runs in Vellum Cloud by default, can run locally or on your own infrastructure, and ships as open-source software. These docs cover setup, memory, channels, skills, tools, hosting, security, and developer workflows.",
    "",
    "Install: `curl -fsSL https://www.vellum.ai/install.sh | bash && . ~/.config/vellum/env`",
    "",
    "Repo: https://github.com/vellum-ai/vellum-assistant",
    "",
    `Docs: ${SITE_URL}/docs`,
    "",
    `Full LLM index: ${SITE_URL}/llms.txt`,
    "",
    `Every page below is served as Markdown at its canonical URL with a \`.md\` suffix (e.g. ${SITE_URL}/docs/getting-started.md) or by sending an \`Accept: text/markdown\` header.`,
    "",
    "## Docs",
    "",
  ];

  const sorted = [...pages].sort((a, b) => a.route.localeCompare(b.route));
  for (const page of sorted) {
    const description = page.description ? `: ${page.description}` : "";
    lines.push(`- [${page.title}](${markdownUrl(page.route)})${description}`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
