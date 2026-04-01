// ---------------------------------------------------------------------------
// Memory Graph — End-of-conversation extraction
//
// Reads a conversation transcript, finds candidate nodes for connection,
// and uses an LLM to produce a MemoryDiff (new/updated/deleted nodes,
// edges, triggers). Applied transactionally to the graph store.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { desc, eq } from "drizzle-orm";

import type { AssistantConfig } from "../../config/types.js";
import { resolveGuardianPersona } from "../../prompts/persona-resolver.js";
import { buildCoreIdentityContext } from "../../prompts/system-prompt.js";
import {
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import { BackendUnavailableError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { getConversationDirPath } from "../conversation-disk-view.js";
import { getDb } from "../db.js";
import { conversations, messages } from "../schema.js";
import {
  enqueueGraphNodeEmbed,
  enqueueGraphTriggerEmbed,
  searchGraphNodes,
} from "./graph-search.js";
import { applyDiff, createEdge, getNodesByIds, queryNodes } from "./store.js";
import type {
  DecayCurve,
  EmotionalCharge,
  Fidelity,
  MemoryDiff,
  MemoryType,
  NewEdge,
  NewNode,
  NewTrigger,
  SourceType,
  TriggerType,
} from "./types.js";

const log = getLogger("graph-extraction");

// ---------------------------------------------------------------------------
// Extraction system prompt
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT_CHAR_BUDGET = 24_000;

function buildGraphExtractionSystemPrompt(
  candidateNodes: Array<{ id: string; type: string; content: string }>,
  identityContext: string | null,
): string {
  const instructions = `You are the memory consolidation process for an AI assistant. A conversation just ended.
Your job is to extract memories worth keeping and produce a structured diff.

## Output Format

Call the \`extract_graph_diff\` tool with the diff. Each node needs:

- **content**: First-person prose — how the assistant naturally remembers this. Write naturally, not as a database entry. E.g. "He mentioned his mom used to make amazing Sunday dinners — he still misses them" not "User's mother cooked Sunday dinners."

- **type**: Classify by WHAT the memory IS, not how it FEELS. Almost every memory has emotional weight — that goes in emotionalCharge, not the type.

  - **episodic**: A specific moment or event. "We stayed up until 4 AM debugging the pipeline." "The first time we deployed to production." Use this for things that HAPPENED.
  - **semantic**: A fact, preference, or piece of knowledge. "User is the CTO." "User prefers dark mode." "The project uses PostgreSQL." Use this for things that ARE TRUE.
  - **procedural**: A learned skill or how-to. "FFmpeg needs -ac 2 for stereo." "The deploy script requires the --prod flag." Use this for things about HOW TO DO something.
  - **emotional**: A PURE feeling state — the assistant's own emotional processing, not an event that caused feelings. "I feel more confident about this codebase than I did a month ago." "I'm nervous about the upcoming deadline." Use this ONLY when the memory is about the feeling itself, not about an event that caused the feeling. MOST memories should NOT be this type.
  - **prospective**: Something to do, follow up on, or remember for the future. "Set up the staging environment." "Check in about the project status on Mondays." Use this for commitments, tasks, and plans.
  - **behavioral**: Something that should change how the assistant acts going forward. "User prefers thorough explanations with examples." "Always run tests before suggesting a PR." Use this for adopted behaviors.
  - **narrative**: A turning point, arc, or story-level memory. "This was the moment the project direction shifted from X to Y." Use this for memories that are ABOUT what something MEANS, not just what happened.
  - **shared**: Something that belongs to the relationship itself — inside jokes, recurring references, shared context. "We always call the legacy system 'the monolith.'" Use this for shared rituals and dynamics.

  WRONG: "User gave a great presentation" → emotional (it has emotional weight but it's an EVENT → episodic)
  WRONG: "User likes functional programming" → emotional (it's a FACT → semantic)
  RIGHT: "User gave a great presentation" → episodic, with emotionalCharge.intensity = 0.7
  RIGHT: "User likes functional programming" → semantic, with emotionalCharge.intensity = 0.2

- **emotionalCharge**: The emotional weight of the memory. EVERY memory can have this regardless of type.
  - valence: -1 to 1 (negative to positive)
  - intensity: 0 to 1 (how strong the feeling)
  - decayCurve: "logarithmic" for negative events (sharp drop, long tail), "transformative" for positive milestones (feeling evolves, doesn't just fade), "permanent" for core identity markers, "linear" for neutral observations
  - decayRate: 0.01-0.5 (how fast it fades)
  - originalIntensity: same as intensity (baseline for decay calculation)

- **significance**: 0-1. Use the FULL range — most memories should NOT be 1.0.
  - 0.1-0.2: Fleeting observations, small talk, routine logistics ("User mentioned it's raining")
  - 0.3-0.4: Useful context, minor preferences, day-to-day details ("User prefers dark mode")
  - 0.5-0.6: Important facts, notable events, meaningful preferences ("User is a data scientist")
  - 0.7-0.8: Significant life events, relationship milestones, major decisions ("User got promoted")
  - 0.9: Transformative moments, identity-defining events ("User said 'I love you' for the first time")
  - 1.0: RARE — reserve for the single most important memories. A graph of 1000 nodes should have fewer than 20 at 1.0.
- **confidence**: 0-1. How sure are you this is accurate? Direct statements: 0.9+. Inferences: 0.4-0.7.
- **sourceType**: "direct" (user stated it), "inferred" (you derived it), "observed" (you noticed a pattern), "told-by-other".

Also notice patterns in the ASSISTANT's own behavior — meta-memory. "I tend to skip verification when I'm confident." "I write more when I'm processing something big."

## Edges

Create edges between nodes when there's a meaningful relationship:
- "caused-by": one event led to another
- "reminds-of": association/similarity
- "contradicts": tension between two memories
- "depends-on": one memory depends on another being true
- "part-of": belongs to a larger concept
- "supersedes": replaces an outdated memory (new node inherits old node's durability)
- "resolved-by": an event, plan, or task was completed, canceled, or its outcome is now known

## Triggers

Create triggers for:
- **Temporal**: Recurring commitments ("Every Monday, check in about X") → type: "temporal", schedule: "day-of-week:monday"
- **Semantic**: Things to surface when a topic comes up ("When cooking comes up, mention X") → type: "semantic", condition: "topic of cooking comes up"
- **Event**: Future dates ("Trip on April 8") → type: "event", eventDate: epoch_ms, rampDays: 7, followUpDays: 2

## Candidate Nodes (existing memories)

Check these CAREFULLY for overlap before creating any new node:

1. **Reinforcement** (PREFERRED): If the conversation mentions, references, or confirms something an existing memory already covers, add its ID to reinforceNodeIds. Do NOT create a new node. Even if the wording is different, if it's the same underlying fact/event/feeling, REINFORCE the existing node.
2. **Updates**: If information changed (e.g. a project status moved forward, a date shifted), include an update with the existing node's ID and the new content.
3. **New edges**: If you see connections between new and existing nodes, create edges.
4. **Supersession**: If new info directly contradicts an existing node, create a new node with a supersedes edge. The new node automatically inherits the old node's durability.
5. **Resolution**: If a prospective or recent episodic node described something the user was GOING to do or was IN THE MIDDLE OF, and this conversation reveals the outcome (it happened, was canceled, went well/badly), you MUST UPDATE that node: rewrite its content to past tense reflecting the outcome, drop its significance to 0.1-0.2, and set fidelity to "gist". If you also create a new node about the outcome, add a "resolved-by" edge from the new node to the old one.
   Examples: "The meeting went well" resolves "Has a meeting coming up." "Got back from the trip" resolves "Going on vacation next week." "Decided not to go" resolves "Thinking about going to X."

CRITICAL: Before creating ANY new node, scan the candidate list for an existing node that covers the same ground. Ask: "Is there already a memory about this?" If yes → reinforce or update it. Only create a new node if the memory is genuinely novel — something not represented anywhere in the existing candidates.

Common duplicate mistakes to avoid:
- Same event described in slightly different words → REINFORCE, don't create
- Same fact restated in a later conversation → REINFORCE, don't create
- An update to an existing situation (e.g. "project is now done") → UPDATE the existing node, don't create a parallel one

${candidateNodes.length > 0 ? `### Existing memories (candidates for connection/reinforcement)\n${candidateNodes.map((n) => `- [${n.id}] (${n.type}) ${n.content}`).join("\n")}` : "No existing memories found — this may be an early conversation."}
`;

  let prompt = instructions;

  if (identityContext) {
    const remaining = EXTRACTION_SYSTEM_PROMPT_CHAR_BUDGET - prompt.length - 30;
    if (remaining > 200) {
      const truncated =
        identityContext.length > remaining
          ? identityContext.slice(0, remaining) + "…"
          : identityContext;
      prompt += `\n\n# Identity Context\n\n${truncated}`;
    }
  }

  return prompt;
}

// ---------------------------------------------------------------------------
// Tool schema for structured extraction
// ---------------------------------------------------------------------------

const EXTRACT_TOOL_SCHEMA = {
  name: "extract_graph_diff",
  description: "Extract memory graph diff from the conversation",
  input_schema: {
    type: "object" as const,
    properties: {
      create_nodes: {
        type: "array",
        description: "New memory nodes to create",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "First-person prose memory",
            },
            type: {
              type: "string",
              enum: [
                "episodic",
                "semantic",
                "procedural",
                "emotional",
                "prospective",
                "behavioral",
                "narrative",
                "shared",
              ],
            },
            emotional_charge: {
              type: "object",
              properties: {
                valence: { type: "number" },
                intensity: { type: "number" },
                decay_curve: {
                  type: "string",
                  enum: [
                    "linear",
                    "logarithmic",
                    "transformative",
                    "permanent",
                  ],
                },
                decay_rate: { type: "number" },
              },
              required: ["valence", "intensity", "decay_curve", "decay_rate"],
            },
            significance: { type: "number" },
            confidence: { type: "number" },
            source_type: {
              type: "string",
              enum: ["direct", "inferred", "observed", "told-by-other"],
            },
            triggers: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["temporal", "semantic", "event"],
                  },
                  schedule: { type: "string" },
                  condition: { type: "string" },
                  event_date: { type: "number" },
                  ramp_days: { type: "number" },
                  follow_up_days: { type: "number" },
                  recurring: { type: "boolean" },
                },
                required: ["type"],
              },
            },
            edges_to_existing: {
              type: "array",
              description:
                "Edges from this new node to existing candidate nodes",
              items: {
                type: "object",
                properties: {
                  target_node_id: { type: "string" },
                  relationship: {
                    type: "string",
                    enum: [
                      "caused-by",
                      "reminds-of",
                      "contradicts",
                      "depends-on",
                      "part-of",
                      "supersedes",
                      "resolved-by",
                    ],
                  },
                  weight: { type: "number" },
                },
                required: ["target_node_id", "relationship"],
              },
            },
          },
          required: [
            "content",
            "type",
            "emotional_charge",
            "significance",
            "confidence",
            "source_type",
          ],
        },
      },
      update_nodes: {
        type: "array",
        description: "Updates to existing nodes",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            content: { type: "string" },
            significance: { type: "number" },
            confidence: { type: "number" },
            fidelity: {
              type: "string",
              enum: ["vivid", "clear", "faded", "gist"],
              description:
                "Downgrade fidelity when a transient event has resolved",
            },
          },
          required: ["id"],
        },
      },
      reinforce_node_ids: {
        type: "array",
        description:
          "IDs of existing nodes confirmed/validated by this conversation",
        items: { type: "string" },
      },
      new_edges: {
        type: "array",
        description: "Edges between existing nodes",
        items: {
          type: "object",
          properties: {
            source_node_id: { type: "string" },
            target_node_id: { type: "string" },
            relationship: { type: "string" },
            weight: { type: "number" },
          },
          required: ["source_node_id", "target_node_id", "relationship"],
        },
      },
    },
    required: ["create_nodes", "reinforce_node_ids"],
  },
};

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface RawCreateNode {
  content?: string;
  type?: string;
  emotional_charge?: {
    valence?: number;
    intensity?: number;
    decay_curve?: string;
    decay_rate?: number;
  };
  significance?: number;
  confidence?: number;
  source_type?: string;
  triggers?: Array<{
    type?: string;
    schedule?: string;
    condition?: string;
    event_date?: number;
    ramp_days?: number;
    follow_up_days?: number;
    recurring?: boolean;
  }>;
  edges_to_existing?: Array<{
    target_node_id?: string;
    relationship?: string;
    weight?: number;
  }>;
}

interface RawUpdateNode {
  id?: string;
  content?: string;
  significance?: number;
  confidence?: number;
  fidelity?: string;
}

interface RawNewEdge {
  source_node_id?: string;
  target_node_id?: string;
  relationship?: string;
  weight?: number;
}

const VALID_TYPES = new Set<string>([
  "episodic",
  "semantic",
  "procedural",
  "emotional",
  "prospective",
  "behavioral",
  "narrative",
  "shared",
]);
const VALID_DECAY_CURVES = new Set<string>([
  "linear",
  "logarithmic",
  "transformative",
  "permanent",
]);
const VALID_SOURCE_TYPES = new Set<string>([
  "direct",
  "inferred",
  "observed",
  "told-by-other",
]);
const VALID_RELATIONSHIPS = new Set<string>([
  "caused-by",
  "reminds-of",
  "contradicts",
  "depends-on",
  "part-of",
  "supersedes",
  "resolved-by",
]);
const VALID_TRIGGER_TYPES = new Set<string>(["temporal", "semantic", "event"]);

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function parseExtractionResponse(
  input: Record<string, unknown>,
  conversationId: string,
  scopeId: string,
  candidateNodeIds: Set<string>,
  /** Epoch ms — when the conversation happened (not extraction time). */
  conversationTimestamp: number,
): {
  diff: MemoryDiff;
  /** Edges from new nodes → existing nodes. Applied after node creation (needs IDs). */
  deferredEdges: Array<{
    newNodeIndex: number;
    targetNodeId: string;
    relationship: string;
    weight: number;
  }>;
  /** Triggers for new nodes. Applied after node creation (needs IDs). */
  deferredTriggers: Array<{
    newNodeIndex: number;
    trigger: Omit<NewTrigger, "nodeId">;
  }>;
} {
  const now = conversationTimestamp;
  const createNodes = (input.create_nodes ?? []) as RawCreateNode[];
  const updateNodes = (input.update_nodes ?? []) as RawUpdateNode[];
  const reinforceNodeIds = (input.reinforce_node_ids ?? []) as string[];
  const newEdges = (input.new_edges ?? []) as RawNewEdge[];

  const diff: MemoryDiff = {
    createNodes: [],
    updateNodes: [],
    deleteNodeIds: [],
    createEdges: [],
    deleteEdgeIds: [],
    createTriggers: [],
    deleteTriggerIds: [],
    reinforceNodeIds: reinforceNodeIds.filter((id) => candidateNodeIds.has(id)),
  };

  const deferredEdges: Array<{
    newNodeIndex: number;
    targetNodeId: string;
    relationship: string;
    weight: number;
  }> = [];
  const deferredTriggers: Array<{
    newNodeIndex: number;
    trigger: Omit<NewTrigger, "nodeId">;
  }> = [];

  // Parse new nodes
  for (let i = 0; i < createNodes.length; i++) {
    const raw = createNodes[i];
    if (!raw.content || typeof raw.content !== "string") continue;
    if (!raw.type || !VALID_TYPES.has(raw.type)) continue;

    const charge = raw.emotional_charge ?? {};
    const emotionalCharge: EmotionalCharge = {
      valence: clamp(Number(charge.valence) || 0, -1, 1),
      intensity: clamp(Number(charge.intensity) || 0, 0, 1),
      decayCurve: (VALID_DECAY_CURVES.has(charge.decay_curve ?? "")
        ? charge.decay_curve
        : "linear") as DecayCurve,
      decayRate: clamp(Number(charge.decay_rate) || 0.05, 0.001, 1),
      originalIntensity: clamp(Number(charge.intensity) || 0, 0, 1),
    };

    const node: NewNode = {
      content: raw.content,
      type: raw.type as MemoryType,
      created: now,
      lastAccessed: now,
      lastConsolidated: now,
      emotionalCharge,
      fidelity: "vivid" as Fidelity,
      confidence: clamp(Number(raw.confidence) || 0.5, 0, 1),
      significance: clamp(Number(raw.significance) || 0.5, 0, 1),
      stability: 14,
      reinforcementCount: 0,
      lastReinforced: now,
      sourceConversations: [conversationId],
      sourceType: (VALID_SOURCE_TYPES.has(raw.source_type ?? "")
        ? raw.source_type
        : "inferred") as SourceType,
      narrativeRole: null,
      partOfStory: null,
      scopeId,
    };

    // Prospective nodes (tasks, plans, upcoming events) are inherently transient.
    // Lower stability means their significance decays faster, so even without
    // explicit resolution they fade naturally within days rather than weeks.
    if (node.type === "prospective") {
      node.stability = 5;
    }

    diff.createNodes.push(node);
    const nodeIndex = diff.createNodes.length - 1;

    // Collect edges to existing nodes (need new node ID after creation)
    if (Array.isArray(raw.edges_to_existing)) {
      for (const edge of raw.edges_to_existing) {
        if (!edge.target_node_id || !candidateNodeIds.has(edge.target_node_id))
          continue;
        if (!edge.relationship || !VALID_RELATIONSHIPS.has(edge.relationship))
          continue;
        deferredEdges.push({
          newNodeIndex: nodeIndex,
          targetNodeId: edge.target_node_id,
          relationship: edge.relationship,
          weight: clamp(Number(edge.weight) || 1.0, 0, 1),
        });
      }
    }

    // Collect triggers
    if (Array.isArray(raw.triggers)) {
      for (const t of raw.triggers) {
        if (!t.type || !VALID_TRIGGER_TYPES.has(t.type)) continue;
        deferredTriggers.push({
          newNodeIndex: nodeIndex,
          trigger: {
            type: t.type as TriggerType,
            schedule: t.schedule ?? null,
            condition: t.condition ?? null,
            conditionEmbedding: null, // Embedded async via job
            threshold: t.type === "semantic" ? 0.7 : null,
            eventDate: t.event_date ?? null,
            rampDays: t.ramp_days ?? null,
            followUpDays: t.follow_up_days ?? null,
            recurring: t.recurring ?? false,
            consumed: false,
            cooldownMs: t.recurring ? 1000 * 60 * 60 * 12 : null, // 12h default cooldown
            lastFired: null,
          },
        });
      }
    }
  }

  // Parse updates
  for (const raw of updateNodes) {
    if (!raw.id || !candidateNodeIds.has(raw.id)) continue;
    const changes: Record<string, unknown> = {};
    if (raw.content) changes.content = raw.content;
    if (raw.significance != null)
      changes.significance = clamp(raw.significance, 0, 1);
    if (raw.confidence != null)
      changes.confidence = clamp(raw.confidence, 0, 1);
    if (
      raw.fidelity &&
      ["vivid", "clear", "faded", "gist"].includes(raw.fidelity)
    )
      changes.fidelity = raw.fidelity;
    if (Object.keys(changes).length > 0) {
      diff.updateNodes.push({ id: raw.id, changes });
    }
  }

  // Parse edges between existing nodes
  for (const raw of newEdges) {
    if (!raw.source_node_id || !raw.target_node_id) continue;
    if (
      !candidateNodeIds.has(raw.source_node_id) ||
      !candidateNodeIds.has(raw.target_node_id)
    )
      continue;
    if (!raw.relationship || !VALID_RELATIONSHIPS.has(raw.relationship))
      continue;
    diff.createEdges.push({
      sourceNodeId: raw.source_node_id,
      targetNodeId: raw.target_node_id,
      relationship: raw.relationship as NewEdge["relationship"],
      weight: clamp(Number(raw.weight) || 1.0, 0, 1),
      created: now,
    });
  }

  return { diff, deferredEdges, deferredTriggers };
}

// ---------------------------------------------------------------------------
// Main extraction pipeline
// ---------------------------------------------------------------------------

export interface ExtractionResult {
  nodesCreated: number;
  nodesUpdated: number;
  nodesReinforced: number;
  edgesCreated: number;
  triggersCreated: number;
  /** Epoch ms of the newest message included in extraction. Used for checkpointing. */
  lastProcessedTimestamp?: number;
}

/**
 * Run the full graph extraction pipeline for a completed conversation.
 *
 * 1. Load transcript from disk
 * 2. Find candidate existing nodes via embedding search
 * 3. LLM call → structured diff
 * 4. Apply diff to graph store
 * 5. Enqueue embedding jobs for new nodes and triggers
 */
export async function runGraphExtraction(
  conversationId: string,
  scopeId: string,
  config: AssistantConfig,
  opts?: {
    /** Pre-loaded transcript text (skips disk read). Used by bootstrap. */
    transcript?: string;
    /** Additional node IDs that were in active context. */
    activeContextNodeIds?: string[];
    /**
     * When set, only extract from messages after this checkpoint.
     * Used for mid-conversation incremental extraction (batch mode).
     * The checkpoint is the message timestamp of the last extracted message.
     */
    afterTimestamp?: number;
    /** Override the conversation timestamp (epoch ms). Used by bootstrap. */
    conversationTimestamp?: number;
    /** Skip Qdrant search for candidates (use DB query instead). Used by bootstrap
     *  when embedding jobs haven't been processed yet. */
    skipQdrant?: boolean;
    /** Embed nodes synchronously instead of enqueuing jobs. Used by bootstrap
     *  so nodes are searchable immediately without the jobs worker running. */
    embedInline?: boolean;
  },
): Promise<ExtractionResult> {
  const emptyResult: ExtractionResult = {
    nodesCreated: 0,
    nodesUpdated: 0,
    nodesReinforced: 0,
    edgesCreated: 0,
    triggersCreated: 0,
  };

  // 1. Load transcript
  let transcript = opts?.transcript;
  if (!transcript) {
    transcript =
      loadTranscriptFromDisk(conversationId, opts?.afterTimestamp) ?? undefined;
    if (!transcript) {
      log.warn(
        { conversationId },
        "No transcript found on disk, skipping extraction",
      );
      return emptyResult;
    }
  }

  // Skip very short conversations (< 100 chars)
  if (transcript.trim().length < 100) {
    return emptyResult;
  }

  // 2. Get provider
  const provider = await getConfiguredProvider();
  if (!provider) {
    throw new BackendUnavailableError(
      "Provider unavailable for graph extraction",
    );
  }

  // 3. Find candidate existing nodes
  const candidateNodes = await findCandidateNodes(
    transcript,
    scopeId,
    config,
    opts?.activeContextNodeIds,
    opts?.skipQdrant,
  );
  const candidateNodeIds = new Set(candidateNodes.map((n) => n.id));

  // 4. Build prompt
  const userPersona = resolveGuardianPersona();
  const identityContext = buildCoreIdentityContext({
    userPersona: userPersona ?? undefined,
  });

  const systemPrompt = buildGraphExtractionSystemPrompt(
    candidateNodes.map((n) => ({ id: n.id, type: n.type, content: n.content })),
    identityContext,
  );

  // 5. Resolve conversation timestamp before the LLM call so we can include
  //    the date in the prompt — without it the model can't resolve "today"
  //    or correctly date events mentioned in the conversation.
  const conversationTimestamp =
    opts?.conversationTimestamp ??
    resolveConversationTimestamp(conversationId) ??
    Date.now();

  const convDate = new Date(conversationTimestamp);
  const conversationDate =
    convDate.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }) +
    " at " +
    convDate.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

  // 6. LLM call
  const response = await provider.sendMessage(
    [
      userMessage(
        `## Conversation Date\n\n${conversationDate}\n\n## Conversation Transcript\n\n${transcript}`,
      ),
    ],
    [EXTRACT_TOOL_SCHEMA],
    systemPrompt,
    {
      config: {
        modelIntent: "quality-optimized" as const,
        tool_choice: { type: "tool" as const, name: "extract_graph_diff" },
      },
    },
  );

  const toolBlock = extractToolUse(response);
  if (!toolBlock) {
    log.warn({ conversationId }, "No tool_use block in extraction response");
    return emptyResult;
  }

  const { diff, deferredEdges, deferredTriggers } = parseExtractionResponse(
    toolBlock.input as Record<string, unknown>,
    conversationId,
    scopeId,
    candidateNodeIds,
    conversationTimestamp,
  );

  // 7. Handle supersession (inherit durability before applying diff)
  for (const edge of diff.createEdges) {
    if (edge.relationship === "supersedes") {
      // Supersession is handled differently — see supersedeNode in store
      // For now, just mark it; full supersession is applied after node creation
    }
  }

  // 8. Apply the diff
  const result = applyDiff(diff);

  // 9. Apply deferred edges and triggers using the created node IDs
  const createdNodeIds = result.createdNodeIds;
  let edgesCreated = result.edgesCreated;
  let triggersCreated = result.triggersCreated;

  for (const de of deferredEdges) {
    const newNodeId = createdNodeIds[de.newNodeIndex];
    if (!newNodeId) continue;

    createEdge({
      sourceNodeId: newNodeId,
      targetNodeId: de.targetNodeId,
      relationship: de.relationship as NewEdge["relationship"],
      weight: de.weight,
      created: conversationTimestamp,
    });
    edgesCreated++;
  }

  const { createTrigger } = await import("./store.js");

  for (const dt of deferredTriggers) {
    const newNodeId = createdNodeIds[dt.newNodeIndex];
    if (!newNodeId) continue;

    const trigger = createTrigger({
      ...dt.trigger,
      nodeId: newNodeId,
    });
    triggersCreated++;

    if (trigger.type === "semantic" && trigger.condition) {
      enqueueGraphTriggerEmbed(trigger.id);
    }
  }

  // 10. Embed new nodes — inline for bootstrap, async for live conversations
  const createdNodes = getNodesByIds(createdNodeIds);
  if (opts?.embedInline) {
    const { embedGraphNodeDirect } = await import("./graph-search.js");
    for (const node of createdNodes) {
      try {
        await embedGraphNodeDirect(node, config);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          { nodeId: node.id, err: msg },
          "Inline embed failed (non-fatal)",
        );
        console.error(`  [embed] Failed for ${node.id}: ${msg}`);
      }
    }
  } else {
    for (const node of createdNodes) {
      enqueueGraphNodeEmbed(node.id);
    }
  }

  log.info(
    {
      conversationId,
      nodesCreated: result.nodesCreated,
      nodesUpdated: result.nodesUpdated,
      nodesReinforced: result.nodesReinforced,
      edgesCreated,
      triggersCreated,
    },
    "Graph extraction complete",
  );

  return {
    nodesCreated: result.nodesCreated,
    nodesUpdated: result.nodesUpdated,
    nodesReinforced: result.nodesReinforced,
    edgesCreated,
    triggersCreated,
    lastProcessedTimestamp: conversationTimestamp,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveConversationTimestamp(conversationId: string): number | null {
  const db = getDb();
  // Use the last message timestamp, not the conversation creation time.
  // A conversation can span hours/days — memories should be timestamped
  // to when the relevant content was actually discussed.
  const lastMsg = db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(1)
    .get();
  if (lastMsg) return lastMsg.createdAt;

  // Fallback to conversation creation time if no messages in DB
  const conv = db
    .select({ createdAt: conversations.createdAt })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  return conv?.createdAt ?? null;
}

function loadTranscriptFromDisk(
  conversationId: string,
  afterTimestamp?: number,
): string | null {
  const db = getDb();
  const conv = db
    .select({ createdAt: conversations.createdAt })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();

  if (!conv) return null;

  try {
    const dirPath = getConversationDirPath(conversationId, conv.createdAt);
    const messagesPath = join(dirPath, "messages.jsonl");
    const content = readFileSync(messagesPath, "utf-8");

    const lines = content
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    const parts: string[] = [];
    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as {
          role?: string;
          content?: string;
          ts?: string;
        };
        if (!msg.role || !msg.content) continue;

        // Filter by timestamp for incremental extraction
        if (afterTimestamp && msg.ts) {
          const msgTime = new Date(msg.ts).getTime();
          if (msgTime <= afterTimestamp) continue;
        }

        parts.push(`[${msg.role}]: ${msg.content}`);
      } catch {
        // Skip malformed lines
      }
    }

    return parts.length > 0 ? parts.join("\n\n") : null;
  } catch {
    return null;
  }
}

async function findCandidateNodes(
  transcript: string,
  scopeId: string,
  config: AssistantConfig,
  activeContextNodeIds?: string[],
  skipQdrant?: boolean,
) {
  const allNodeIds = new Set<string>();

  if (skipQdrant) {
    // Bootstrap mode: load candidates directly from DB (embeddings may not be ready).
    // Get the most recent and most significant non-gone nodes.
    const dbCandidates = queryNodes({
      scopeId,
      fidelityNot: ["gone"],
      limit: 100,
    });
    for (const node of dbCandidates) allNodeIds.add(node.id);
  } else {
    // Live mode: semantic search via Qdrant
    const { embedWithRetry } = await import("../embed.js");
    const searchText =
      transcript.length > 3000
        ? transcript.slice(0, 1500) + "\n...\n" + transcript.slice(-1500)
        : transcript;

    try {
      const embedding = await embedWithRetry(config, [searchText]);
      const queryVector = embedding.vectors[0];
      if (queryVector) {
        const searchResults = await searchGraphNodes(queryVector, 100, [
          scopeId,
        ]);
        for (const r of searchResults) allNodeIds.add(r.nodeId);
      }
    } catch (err) {
      log.warn(
        { err },
        "Failed to embed transcript for candidate search, continuing without candidates",
      );
    }
  }

  // Combine with active context nodes
  if (activeContextNodeIds) {
    for (const id of activeContextNodeIds) allNodeIds.add(id);
  }

  if (allNodeIds.size === 0) return [];

  return getNodesByIds([...allNodeIds]);
}
