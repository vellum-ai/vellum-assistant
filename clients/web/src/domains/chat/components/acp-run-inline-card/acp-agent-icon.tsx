// Leading glyph for an ACP run, keyed off the backing agent. Known agents show
// their brand mark (the same SVGs used by the onboarding prior-assistant
// picker); anything unrecognised falls back to a neutral `Code` glyph so a new
// agent string never renders blank. Matching is substring-based so model
// variants ("claude-sonnet", "gpt-5-codex") still resolve.

import { Code } from "lucide-react";

import { publicAsset } from "@/utils/public-asset";

/** Resolve an agent string to a brand SVG under /images/prior-assistants, if known. */
function brandSrc(agent: string): string | undefined {
  const a = agent.toLowerCase();
  if (a.includes("claude")) return "/images/prior-assistants/claude.svg";
  if (a.includes("codex") || a.includes("openai") || a.includes("gpt"))
    return "/images/prior-assistants/chatgpt.svg";
  if (a.includes("copilot")) return "/images/prior-assistants/copilot.svg";
  return undefined;
}

export function AcpAgentIcon({
  agent,
  className = "h-4 w-4 shrink-0",
}: {
  agent: string | undefined;
  className?: string;
}) {
  const src = agent ? brandSrc(agent) : undefined;
  if (src) {
    return (
      <img
        src={publicAsset(src)}
        alt=""
        aria-hidden
        data-testid="acp-agent-icon-brand"
        className={className}
      />
    );
  }
  return (
    <Code
      className={`${className} text-[var(--content-secondary)]`}
      aria-hidden
    />
  );
}
