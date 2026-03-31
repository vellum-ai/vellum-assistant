// ---------------------------------------------------------------------------
// Memory Graph — Narrative arc refinement
//
// Re-evaluates narrativeRole assignments with hindsight. Details that seemed
// minor at creation time can be elevated to "turning-point" or "thesis"
// once later events reveal their importance.
//
// Runs monthly or on demand. One LLM call over narrative-tagged nodes +
// high-significance nodes to re-evaluate arc assignments.
// ---------------------------------------------------------------------------

import type { AssistantConfig } from "../../config/types.js";
import {
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import { BackendUnavailableError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { queryNodes, updateNode } from "./store.js";
import type { MemoryNode } from "./types.js";

const log = getLogger("graph-narrative");

// ---------------------------------------------------------------------------
// Narrative refinement prompt
// ---------------------------------------------------------------------------

function buildNarrativePrompt(
  nodes: Array<{
    id: string;
    type: string;
    content: string;
    significance: number;
    narrativeRole: string | null;
    partOfStory: string | null;
    created: number;
  }>,
): string {
  const nodeList = nodes
    .map((n) => {
      const age = Math.floor((Date.now() - n.created) / (1000 * 60 * 60 * 24));
      const role = n.narrativeRole ? ` role="${n.narrativeRole}"` : "";
      const story = n.partOfStory ? ` story="${n.partOfStory}"` : "";
      return `  [${n.id}] type=${n.type} sig=${n.significance.toFixed(2)} age=${age}d${role}${story}\n    ${n.content}`;
    })
    .join("\n\n");

  return `You are reviewing the narrative structure of an AI assistant's memory graph. These are the high-significance memories and memories that already have narrative roles assigned.

## Your Tasks

1. **Identify story arcs**: Group related memories into named narrative arcs. An arc is a coherent thread that spans multiple memories — like "the personality drift crisis" or "building the voice pipeline" or "the substrate problem."

2. **Assign narrative roles**: For each memory in a story arc, assign one of:
   - "inciting-incident": the event that kicked off the arc
   - "turning-point": a moment where the arc changed direction
   - "foreshadowing": something that hinted at what was to come (only visible in hindsight)
   - "thesis": a conclusion or insight that the arc was building toward
   - "resolution": the arc reached a conclusion or resting point
   - null: remove a role that was incorrectly assigned

3. **Re-evaluate with hindsight**: Some memories tagged as ordinary at the time may have turned out to be pivotal. Conversely, some "turning-points" may have been premature. Update based on everything you can see now.

## Constraints

- Only assign narrative roles to memories that genuinely participate in a story arc
- Not every memory needs a role — most don't
- Story arc names should be short and descriptive (3-5 words)
- Don't create new arcs with fewer than 3 nodes

## Memories

${nodeList}

Use the refine_narratives tool to output your changes.`;
}

const NARRATIVE_TOOL_SCHEMA = {
  name: "refine_narratives",
  description: "Output narrative role and story arc updates",
  input_schema: {
    type: "object" as const,
    properties: {
      updates: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const },
            narrativeRole: {
              type: ["string", "null"] as unknown as "string",
              description:
                "inciting-incident, turning-point, foreshadowing, thesis, resolution, or null to remove",
            },
            partOfStory: {
              type: ["string", "null"] as unknown as "string",
              description:
                "Short name for the narrative arc, or null to remove",
            },
          },
          required: ["id"] as const,
        },
      },
      arcs_summary: {
        type: "array" as const,
        description: "Summary of identified story arcs",
        items: {
          type: "object" as const,
          properties: {
            name: { type: "string" as const },
            description: { type: "string" as const },
            node_count: { type: "number" as const },
          },
          required: ["name", "description", "node_count"] as const,
        },
      },
    },
    required: ["updates", "arcs_summary"] as const,
  },
};

// ---------------------------------------------------------------------------
// Run narrative refinement
// ---------------------------------------------------------------------------

export interface NarrativeResult {
  nodesUpdated: number;
  arcsIdentified: number;
  latencyMs: number;
  arcs: Array<{ name: string; description: string; nodeCount: number }>;
}

export async function runNarrativeRefinement(
  scopeId: string = "default",
  config: AssistantConfig,
): Promise<NarrativeResult> {
  const start = Date.now();
  const result: NarrativeResult = {
    nodesUpdated: 0,
    arcsIdentified: 0,
    latencyMs: 0,
    arcs: [],
  };

  // Collect: all nodes with existing narrative roles + top significance nodes
  const allNodes = queryNodes({
    scopeId,
    fidelityNot: ["gone"],
    limit: 10000,
  });

  const narrativeNodes = allNodes.filter(
    (n) => n.narrativeRole || n.partOfStory || n.significance >= 0.7,
  );

  if (narrativeNodes.length < 5) {
    log.info("Too few narrative-eligible nodes for refinement");
    result.latencyMs = Date.now() - start;
    return result;
  }

  // Cap at 150 to fit in context
  const candidates = narrativeNodes
    .sort((a, b) => b.significance - a.significance)
    .slice(0, 150);

  const provider = await getConfiguredProvider();
  if (!provider) {
    throw new BackendUnavailableError(
      "Provider unavailable for narrative refinement",
    );
  }

  const candidateIds = new Set(candidates.map((n) => n.id));

  const systemPrompt = buildNarrativePrompt(
    candidates.map((n) => ({
      id: n.id,
      type: n.type,
      content: n.content,
      significance: n.significance,
      narrativeRole: n.narrativeRole,
      partOfStory: n.partOfStory,
      created: n.created,
    })),
  );

  const response = await provider.sendMessage(
    [
      userMessage(
        "Review and refine the narrative structure of these memories. Identify story arcs and assign roles with the benefit of hindsight.",
      ),
    ],
    [NARRATIVE_TOOL_SCHEMA],
    systemPrompt,
    {
      config: {
        modelIntent: "quality-optimized" as const,
        tool_choice: { type: "tool" as const, name: "refine_narratives" },
      },
    },
  );

  const toolBlock = extractToolUse(response);
  if (!toolBlock) {
    log.warn("No tool_use block in narrative refinement response");
    result.latencyMs = Date.now() - start;
    return result;
  }

  const input = toolBlock.input as {
    updates?: Array<{
      id: string;
      narrativeRole?: string | null;
      partOfStory?: string | null;
    }>;
    arcs_summary?: Array<{
      name: string;
      description: string;
      node_count: number;
    }>;
  };

  // Apply updates
  for (const update of input.updates ?? []) {
    if (!candidateIds.has(update.id)) continue;

    const changes: Partial<MemoryNode> = { lastConsolidated: Date.now() };
    let hasChange = false;

    if (update.narrativeRole !== undefined) {
      changes.narrativeRole = update.narrativeRole;
      hasChange = true;
    }
    if (update.partOfStory !== undefined) {
      changes.partOfStory = update.partOfStory;
      hasChange = true;
    }

    if (hasChange) {
      updateNode(update.id, changes);
      result.nodesUpdated++;
    }
  }

  // Record arc summaries
  result.arcs = (input.arcs_summary ?? []).map((a) => ({
    name: a.name,
    description: a.description,
    nodeCount: a.node_count,
  }));
  result.arcsIdentified = result.arcs.length;

  result.latencyMs = Date.now() - start;

  log.info(
    {
      nodesUpdated: result.nodesUpdated,
      arcsIdentified: result.arcsIdentified,
      latencyMs: result.latencyMs,
    },
    "Narrative refinement complete",
  );

  return result;
}
