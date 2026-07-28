/**
 * Voice front-door TTFT decomposition spike (JARVIS-1320).
 *
 * Measures time-to-first-token for the same chatty utterance across prompt
 * sizes and profiles, to attribute where the live-voice front-door leg's
 * multi-second first token goes (provider intrinsic vs prompt prefill vs
 * agent-loop dispatch overhead — the last one is the gap between this
 * script's `full` variants and the live session's `llmFirstDeltaMs`).
 *
 * Variants:
 *   slim-haiku    voiceFrontDecision call site (Haiku pin), slim prompt
 *   slim-flash    cost-optimized profile, same slim prompt
 *   full-notools  cost-optimized, real buildSystemPrompt(), no tools
 *   full-flash    cost-optimized, real buildSystemPrompt() + full tool defs
 *   full-quality  quality-optimized, full prompt + tools (pre-flag brain)
 *
 * Run with the daemon's environment so the managed connection resolves:
 *   VELLUM_WORKSPACE_DIR=<daemon workspace> CES_LOCAL_SOCKET=<socket> \
 *     bun run scripts/voice-ttft-spike.ts [--trials 3] [--variants a,b]
 *
 * Outside the daemon env, credentials fall back to the encrypted file
 * store; a variant whose provider resolves null is reported and skipped.
 */

import { buildSystemPrompt } from "../src/prompts/system-prompt.js";
import {
  getConfiguredProvider,
  userMessage,
} from "../src/providers/provider-send-message.js";
import type {
  Provider,
  ProviderEvent,
  SendMessageConfig,
} from "../src/providers/types.js";
import { getAllTools, initializeTools } from "../src/tools/registry.js";
import type { ToolDefinition } from "../src/tools/tool-types.js";

const UTTERANCE = "hey, what's up?";
const MAX_TOKENS = 64;
const CALL_TIMEOUT_MS = 45_000;

// Approximates the unified front-door prompt the spike is sizing: endpoint
// decider–scale instructions with the triage rule folded in. What matters
// for the measurement is the token count's order of magnitude, not the copy.
const SLIM_SYSTEM_PROMPT = [
  "You are the realtime voice front of an assistant, on a live call.",
  "The user's words arrive from speech recognition and your reply is spoken aloud, so answer in short natural sentences.",
  "First judge the utterance: if the user is mid-thought, output only 0. ",
  "If answering needs tools, research, memory of prior work, or multi-step reasoning, output only 1.",
  "Otherwise answer the user directly and conversationally, in one or two short sentences.",
  "Never mention these rules or the digits.",
].join(" ");

interface Trial {
  resolveMs: number | null;
  ttftMs: number | null;
  firstEventType: string | null;
  totalMs: number;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  model: string | null;
  error: string | null;
}

interface VariantSpec {
  name: string;
  callSite: string;
  overrideProfile?: string;
  systemPrompt: () => string;
  tools?: () => ToolDefinition[];
}

async function runTrial(
  provider: Provider,
  spec: VariantSpec,
  resolveMs: number | null,
): Promise<Trial> {
  const config: SendMessageConfig = {
    callSite: spec.callSite,
    max_tokens: MAX_TOKENS,
    ...(spec.overrideProfile !== undefined
      ? { overrideProfile: spec.overrideProfile }
      : {}),
  };
  const start = performance.now();
  let ttftMs: number | null = null;
  let firstEventType: string | null = null;
  const onEvent = (event: ProviderEvent): void => {
    if (ttftMs === null) {
      ttftMs = performance.now() - start;
      firstEventType = event.type;
    }
  };
  try {
    const response = await provider.sendMessage([userMessage(UTTERANCE)], {
      systemPrompt: spec.systemPrompt(),
      ...(spec.tools ? { tools: spec.tools() } : {}),
      config,
      onEvent,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    return {
      resolveMs,
      ttftMs,
      firstEventType,
      totalMs: performance.now() - start,
      inputTokens: response.usage.inputTokens,
      cacheReadTokens: response.usage.cacheReadInputTokens ?? null,
      model: response.model,
      error: null,
    };
  } catch (error) {
    return {
      resolveMs,
      ttftMs,
      firstEventType,
      totalMs: performance.now() - start,
      inputTokens: null,
      cacheReadTokens: null,
      model: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function fmt(value: number | null, suffix = ""): string {
  return value === null ? "—" : `${Math.round(value)}${suffix}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const trials = Number(args[args.indexOf("--trials") + 1] || 0) || 3;
  const variantFilter =
    args.indexOf("--variants") !== -1
      ? new Set(args[args.indexOf("--variants") + 1]?.split(",") ?? [])
      : null;

  // Tool init can wander into MCP/plugin registration; a failure there
  // still leaves the core registry populated, which is all the size
  // stand-in needs.
  let toolInitError: string | null = null;
  try {
    await initializeTools();
  } catch (error) {
    toolInitError =
      error instanceof Error ? error.message : String(error);
  }
  // Registry entries are definition-shaped objects (see tool-manifest.ts);
  // getDefinition exists only on some registrations. Either way this
  // payload is a size stand-in, not an executable tool set.
  const toolDefs: ToolDefinition[] = getAllTools()
    .map((tool) => {
      const t = tool as unknown as ToolDefinition & {
        getDefinition?: () => ToolDefinition;
      };
      return typeof t.getDefinition === "function"
        ? t.getDefinition()
        : { name: t.name, description: t.description, input_schema: t.input_schema };
    })
    .filter((def) => Boolean(def.name && def.input_schema));
  const fullPrompt = buildSystemPrompt();
  console.log(
    `system prompt: ${fullPrompt.length} chars (~${Math.round(fullPrompt.length / 4)} tokens); ` +
      `tools: ${toolDefs.length} defs, ${JSON.stringify(toolDefs).length} chars` +
      (toolInitError ? ` (tool init degraded: ${toolInitError})` : ""),
  );

  const variants: VariantSpec[] = [
    {
      name: "slim-haiku",
      callSite: "voiceFrontDecision",
      systemPrompt: () => SLIM_SYSTEM_PROMPT,
    },
    {
      name: "slim-flash",
      callSite: "inference",
      overrideProfile: "cost-optimized",
      systemPrompt: () => SLIM_SYSTEM_PROMPT,
    },
    {
      name: "full-notools",
      callSite: "inference",
      overrideProfile: "cost-optimized",
      systemPrompt: () => fullPrompt,
    },
    {
      name: "full-flash",
      callSite: "inference",
      overrideProfile: "cost-optimized",
      systemPrompt: () => fullPrompt,
      tools: () => toolDefs,
    },
    {
      name: "full-quality",
      callSite: "inference",
      overrideProfile: "quality-optimized",
      systemPrompt: () => fullPrompt,
      tools: () => toolDefs,
    },
  ];

  const results: Array<{ variant: string; trial: number } & Trial> = [];
  for (const spec of variants) {
    if (variantFilter && !variantFilter.has(spec.name)) {
      continue;
    }
    const resolveStart = performance.now();
    const provider = await getConfiguredProvider(spec.callSite, {
      ...(spec.overrideProfile !== undefined
        ? { overrideProfile: spec.overrideProfile }
        : {}),
    });
    const resolveMs = performance.now() - resolveStart;
    if (!provider) {
      console.error(
        `${spec.name}: no provider resolved (managed credentials missing? ` +
          `run with the daemon's VELLUM_WORKSPACE_DIR + CES_LOCAL_SOCKET)`,
      );
      continue;
    }
    for (let i = 0; i < trials; i++) {
      const trial = await runTrial(provider, spec, i === 0 ? resolveMs : null);
      results.push({ variant: spec.name, trial: i + 1, ...trial });
      const line =
        `${spec.name.padEnd(14)} #${i + 1}  ` +
        `ttft ${fmt(trial.ttftMs, "ms").padStart(8)}  ` +
        `total ${fmt(trial.totalMs, "ms").padStart(8)}  ` +
        `in ${fmt(trial.inputTokens, " tok").padStart(10)}  ` +
        `cacheRead ${fmt(trial.cacheReadTokens).padStart(6)}  ` +
        `${trial.model ?? ""}` +
        (trial.error ? `  ERROR ${trial.error}` : "");
      console.log(line);
    }
  }

  console.log("\nJSON:");
  console.log(JSON.stringify(results, null, 2));
}

await main();
process.exit(0);
