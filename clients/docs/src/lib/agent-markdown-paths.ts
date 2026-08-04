/**
 * Public markdown alternate URL for a docs page. Lives under /docs/* (e.g.
 * /docs/pricing -> /docs/pricing.md) because ingress only routes /docs/* to
 * this app; the platform's legacy /md/* URLs would hit the old app.
 */
export function agentMarkdownPathForPage(path: string): string | undefined {
  if (path === "/docs") {
    return "/docs/index.md";
  }

  if (path.startsWith("/docs/")) {
    return `${path}.md`;
  }

  return undefined;
}
