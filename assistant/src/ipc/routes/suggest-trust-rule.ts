import {
  createTimeout,
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import type { IpcRoute } from "../assistant-server.js";

// ---------------------------------------------------------------------------
// Request / response interfaces
// ---------------------------------------------------------------------------

interface ScopeOption {
  pattern: string;
  label: string;
}

interface DirectoryScopeOption {
  scope: string;
  label: string;
}

interface SuggestTrustRuleRequest {
  tool: string;
  command: string;
  riskAssessment: { risk: string; reasoning: string; reasonDescription: string };
  scopeOptions: ScopeOption[];
  directoryScopeOptions?: DirectoryScopeOption[];
  currentThreshold: string;
  intent: "auto_approve" | "escalate";
}

interface SuggestTrustRuleResponse {
  pattern: string;
  risk: string;
  scope?: string;
  description: string;
  scopeOptions: ScopeOption[];
  directoryScopeOptions?: DirectoryScopeOption[];
}

// ---------------------------------------------------------------------------
// Structured-output LLM tool definition
// ---------------------------------------------------------------------------

const SUGGEST_RULE_TOOL = {
  name: "suggest_trust_rule",
  description: "Suggest a trust rule for the given command.",
  input_schema: {
    type: "object" as const,
    properties: {
      pattern: {
        type: "string",
        description:
          "Glob pattern for the trust rule (e.g. 'rm -rf *' or 'git push *')",
      },
      risk: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Risk level to assign to this pattern",
      },
      scope: {
        type: "string",
        description:
          "Optional directory scope path glob (e.g. '/workspace/scratch/*') or 'everywhere'. Omit for non-filesystem commands.",
      },
      description: {
        type: "string",
        description: "Human-friendly one-liner describing what this rule does",
      },
    },
    required: ["pattern", "risk", "description"],
  },
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are helping a developer configure trust rules for an AI coding assistant.

Trust rules classify commands into risk levels:
- low: safe/read-only commands that auto-approve when threshold ≤ low
- medium: write/network commands that auto-approve when threshold ≤ medium
- high: destructive/irreversible commands that always prompt

A user's "auto-approve threshold" controls which risk levels auto-approve. If threshold
is "medium", then low and medium commands auto-approve; high always prompts.

Your task: suggest ONE trust rule for a specific command invocation. The user has
indicated their intent:
- "auto_approve": pick a risk level ≤ currentThreshold so this class of commands
  auto-approves in future (the user wants less friction for this command type)
- "escalate": pick a risk level > currentThreshold so this class of commands
  prompts in future (the user wants to be asked before running this type)

The scopeOptions are pre-generated pattern options for this command (narrowest to
broadest). You may select one of these or generate your own pattern that better
captures the intent. The goal is a pattern specific enough to be meaningful but
broad enough to cover similar future invocations.

Respond using the suggest_trust_rule tool only.`;

// ---------------------------------------------------------------------------
// User message builder
// ---------------------------------------------------------------------------

function buildUserMessage(req: SuggestTrustRuleRequest): string {
  const lines: string[] = [];

  lines.push(`Tool: ${req.tool}`);
  lines.push(`Command: ${req.command}`);
  lines.push(
    `Risk assessment: ${req.riskAssessment.risk} — ${req.riskAssessment.reasonDescription}`,
  );
  lines.push("");

  lines.push("Scope options (narrowest to broadest):");
  for (const opt of req.scopeOptions) {
    lines.push(`- "${opt.pattern}" — ${opt.label}`);
  }

  if (req.directoryScopeOptions && req.directoryScopeOptions.length > 0) {
    lines.push("");
    lines.push("Directory scope options:");
    for (const opt of req.directoryScopeOptions) {
      lines.push(`- ${opt.scope} — ${opt.label}`);
    }
  }

  lines.push("");
  lines.push(
    `Current threshold: ${req.currentThreshold} (commands ≤ ${req.currentThreshold} auto-approve)`,
  );
  lines.push(`Intent: ${req.intent}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function suggestTrustRuleHandler(
  params?: Record<string, unknown>,
): Promise<SuggestTrustRuleResponse> {
  const req = params as unknown as SuggestTrustRuleRequest;

  const provider = await getConfiguredProvider("trustRuleSuggestion");
  if (!provider) {
    throw new Error("No LLM provider configured for trustRuleSuggestion");
  }

  const { signal, cleanup } = createTimeout(30_000);
  try {
    const response = await provider.sendMessage(
      [userMessage(buildUserMessage(req))],
      [SUGGEST_RULE_TOOL],
      SYSTEM_PROMPT,
      {
        config: {
          callSite: "trustRuleSuggestion",
          max_tokens: 512,
          tool_choice: { type: "tool" as const, name: "suggest_trust_rule" },
        },
        signal,
      },
    );
    cleanup();

    const toolBlock = extractToolUse(response);
    if (!toolBlock) {
      throw new Error(
        "No tool_use block in trust rule suggestion response",
      );
    }

    const input = toolBlock.input as Record<string, unknown>;
    return {
      pattern: input.pattern as string,
      risk: input.risk as string,
      scope: input.scope as string | undefined,
      description: input.description as string,
      scopeOptions: req.scopeOptions,
      directoryScopeOptions: req.directoryScopeOptions,
    };
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Route export
// ---------------------------------------------------------------------------

export const suggestTrustRuleRoute: IpcRoute = {
  method: "suggest_trust_rule",
  handler: suggestTrustRuleHandler,
};
