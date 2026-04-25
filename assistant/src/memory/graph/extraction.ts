// ---------------------------------------------------------------------------
// Memory Graph — End-of-conversation extraction
//
// Reads a conversation transcript, finds candidate nodes for connection,
// and uses an LLM to produce a MemoryDiff (new/updated/deleted nodes,
// edges, triggers). Applied transactionally to the graph store.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { and, asc, desc, eq, gt } from "drizzle-orm";

import type { AssistantConfig } from "../../config/types.js";
import { resolveGuardianPersona } from "../../prompts/persona-resolver.js";
import { buildCoreIdentityContext } from "../../prompts/system-prompt.js";
import {
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import type {
  ContentBlock,
  ImageContent,
  Message,
} from "../../providers/types.js";
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
  ImageRef,
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
  activeContextNodeIds?: Set<string>,
): string {
  const instructions = `You are the memory consolidation process for an AI assistant. A conversation just ended.
Your job is to extract memories worth keeping and produce a structured diff.

## Output Format

Call the \`extract_graph_diff\` tool with the diff. Each node needs:

- **content**: First-person prose — how the assistant naturally remembers this. Write naturally, not as a database entry. E.g. "He mentioned his mom used to make amazing Sunday dinners — he still misses them" not "User's mother cooked Sunday dinners."

**LENGTH: 1-3 sentences. HARD CAP — no exceptions.** This applies to every memory, including 1.0-significance transformative moments. Emotional weight lives in \`emotionalCharge\`, not wordcount. The more significant an event feels, the stronger the pull to preserve narrative — resist it. A memory whose \`content\` exceeds ~300 characters is a bug.

If a memory has multiple distinct facts or beats, **split into multiple nodes connected by edges** (\`caused-by\`, \`part-of\`, \`reminds-of\`) — one node per fact or moment. Never pack a multi-beat story into a single content field. To connect two NEW nodes you create in the same diff, assign each a distinct \`temp_id\` (e.g. \`"new-1"\`, \`"new-2"\`) and reference that temp_id from \`edges_to_existing\` or \`new_edges\`. Temp IDs live only inside this single extraction call — pick values that clearly don't collide with existing candidate IDs.

Do not: set the scene, describe surrounding context, preserve dialogue verbatim, catalog every emotional nuance, or narrate "what it meant." Write the SNAPSHOT. The \`emotionalCharge\` and \`significance\` fields carry the weight — content stays lean.

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
- **event_date**: If this memory is anchored to a specific future date/time (flight, appointment, birthday, deadline, trip), provide the epoch ms. Use the conversation date above to resolve relative references ("next Tuesday", "tomorrow"). ALSO create a matching event trigger with the same date. Leave null for open-ended plans or recurring patterns.
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

Edges can connect any pair of nodes: existing ↔ existing, new ↔ existing, or new ↔ new. Use \`edges_to_existing\` on a new node to declare outbound edges from that node (target may be an existing candidate ID or a sibling new node's \`temp_id\`). Use top-level \`new_edges\` for edges where the source is existing or where it's cleaner to declare the edge once by referencing both endpoints by ID/temp_id.

## Triggers

Create triggers for:
- **Temporal**: Recurring commitments ("Every Monday, check in about X") → type: "temporal", schedule: "day-of-week:monday"
- **Semantic**: Things to surface when a topic comes up ("When cooking comes up, mention X") → type: "semantic", condition: "topic of cooking comes up"
- **Event**: Future dates ("Trip on April 8") → type: "event", eventDate: epoch_ms, rampDays: 7, followUpDays: 2

## Images in Conversation

When the conversation contains images (marked with <image> tags and shown inline), you may attach them to memories using image_refs. Include image_refs for images that are meaningful:
- Photos of people — describe them in detail (appearance, clothing, expression, setting)
- Photos the user shared to show you something about themselves or their life
- Diagrams, drawings, or visual content that was discussed

Do NOT attach images that are incidental (screenshots of error messages fully described in text, generic UI screenshots, etc.).

Write detailed descriptions — these are used for text-based retrieval when visual search isn't available.

${(() => {
  const reconsolidationNodes = activeContextNodeIds?.size
    ? candidateNodes.filter((n) => activeContextNodeIds.has(n.id))
    : [];
  const otherCandidates = activeContextNodeIds?.size
    ? candidateNodes.filter((n) => !activeContextNodeIds.has(n.id))
    : candidateNodes;

  const reconsolidationSection =
    reconsolidationNodes.length > 0
      ? `## Reconsolidation Window

These memories were ACTIVELY RECALLED during this conversation — the user and
assistant both saw them. Recalled memories are in a reconsolidation window and
should be the FIRST candidates for updating with new information.

When a recalled memory relates to what was discussed:
- Conversation CONFIRMS what the memory says → REINFORCE it
- Conversation adds new detail or nuance → UPDATE it with richer content
- Conversation reveals the memory is outdated or wrong → UPDATE it or create a superseding node
- Conversation is unrelated to this memory → leave it alone

STRONG PREFERENCE: Update a recalled memory rather than creating a new node that
partially overlaps. The recalled memory already has history, reinforcement count,
and edge connections — enriching it preserves that context graph.

### Recalled memories
${reconsolidationNodes.map((n) => `- [${n.id}] (${n.type}) ${n.content}`).join("\n")}

`
      : "";

  const candidateHeader =
    reconsolidationNodes.length > 0
      ? "## Other Candidate Nodes (existing memories not in this conversation)"
      : "## Candidate Nodes (existing memories)";

  const candidateSection = `${candidateHeader}

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

${otherCandidates.length > 0 ? `### Existing memories (candidates for connection/reinforcement)\n${otherCandidates.map((n) => `- [${n.id}] (${n.type}) ${n.content}`).join("\n")}` : reconsolidationNodes.length > 0 ? "All existing memories are shown in the reconsolidation section above." : "No existing memories found — this may be an early conversation."}`;

  return reconsolidationSection + candidateSection;
})()}
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
            temp_id: {
              type: "string",
              description:
                "Optional local identifier for this new node. Reference it from edges_to_existing.target_node_id or new_edges.source_node_id/target_node_id to connect two new nodes created in the same diff. Scope is this single call only — pick distinctive values (e.g. 'new-1') that won't collide with existing candidate IDs.",
            },
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
            event_date: {
              type: ["number", "null"],
              description:
                "Epoch ms of the event date for calendar-anchored events (flights, appointments, birthdays, deadlines). Null for non-event memories.",
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
                "Outbound edges from this new node. target_node_id may be an existing candidate node ID OR the temp_id of another new node in this same extraction.",
              items: {
                type: "object",
                properties: {
                  target_node_id: {
                    type: "string",
                    description:
                      "An existing candidate node ID, or the temp_id of another node in create_nodes.",
                  },
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
            image_refs: {
              type: "array",
              description:
                "Images from the conversation to attach to this memory. Reference using message_id and block_index from the <image> tags.",
              items: {
                type: "object",
                properties: {
                  message_id: { type: "string" },
                  block_index: { type: "number" },
                  description: {
                    type: "string",
                    description:
                      "Detailed description of what this image shows, including who is in it if applicable",
                  },
                },
                required: ["message_id", "block_index", "description"],
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
            event_date: {
              type: ["number", "null"],
              description:
                "Epoch ms of the event date. Use to update when an event is rescheduled. Set to null to clear.",
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
        description:
          "Edges between any pair of nodes (existing ↔ existing, new ↔ existing, or new ↔ new). Each endpoint may be an existing candidate node ID or the temp_id of a node declared in create_nodes.",
        items: {
          type: "object",
          properties: {
            source_node_id: {
              type: "string",
              description:
                "An existing candidate node ID, or the temp_id of a node in create_nodes.",
            },
            target_node_id: {
              type: "string",
              description:
                "An existing candidate node ID, or the temp_id of a node in create_nodes.",
            },
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
  temp_id?: string;
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
  event_date?: number;
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
  image_refs?: Array<{
    message_id?: string;
    block_index?: number;
    description?: string;
  }>;
}

interface RawUpdateNode {
  id?: string;
  content?: string;
  significance?: number;
  confidence?: number;
  fidelity?: string;
  event_date?: number | null;
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

/** Coerce an LLM-returned event_date to number | null, guarding against string values. */
export function parseEpochMs(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * An edge endpoint that may reference either a pre-existing candidate node
 * (by its real ID) or a brand-new node being created in the same diff
 * (by its index into `diff.createNodes`, resolved to a real ID after apply).
 */
export type DeferredEdgeEndpoint =
  | { kind: "existing"; nodeId: string }
  | { kind: "new"; newNodeIndex: number };

export interface DeferredEdge {
  source: DeferredEdgeEndpoint;
  target: DeferredEdgeEndpoint;
  relationship: string;
  weight: number;
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
  /**
   * Edges with at least one endpoint that is a new node (new→existing,
   * existing→new, or new→new). Applied after node creation so new node IDs
   * can be resolved from their indices.
   */
  deferredEdges: DeferredEdge[];
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

  const deferredEdges: DeferredEdge[] = [];
  const deferredTriggers: Array<{
    newNodeIndex: number;
    trigger: Omit<NewTrigger, "nodeId">;
  }> = [];

  // Track raw-index → diff-index for nodes that pass validation. Edges
  // reference nodes by temp_id, which resolves via the raw index — but
  // deferredEdges must carry the diff index (aligns with createdNodeIds
  // in applyDiff's return value).
  const rawIndexToDiffIndex = new Map<number, number>();

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
      eventDate: parseEpochMs(raw.event_date),
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
      imageRefs: null,
      scopeId,
    };

    // Prospective nodes (tasks, plans, upcoming events) are inherently transient.
    // Lower stability means their significance decays faster, so even without
    // explicit resolution they fade naturally within days rather than weeks.
    if (node.type === "prospective") {
      node.stability = 5;
    }

    // Procedural nodes (learned skills, how-to knowledge — "ffmpeg needs -ac 2
    // for stereo") encode facts that stay useful long after the moment they
    // were learned. Higher initial stability slows Ebbinghaus decay so they
    // remain retrievable months later without needing explicit reinforcement.
    if (node.type === "procedural") {
      node.stability = 60;
    }

    diff.createNodes.push(node);
    const nodeIndex = diff.createNodes.length - 1;
    rawIndexToDiffIndex.set(i, nodeIndex);

    // Edges declared on this new node are processed in a second pass below
    // — they can reference sibling new nodes via temp_id, which may appear
    // later in create_nodes than the edge's declaring node.

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
            eventDate: parseEpochMs(t.event_date),
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

    // Auto-create event trigger when event_date is set but LLM didn't include one,
    // or replace a malformed event trigger (event_date unset) with a valid one.
    if (
      node.eventDate != null &&
      (!Array.isArray(raw.triggers) ||
        !raw.triggers.some((t) => t.type === "event" && t.event_date != null))
    ) {
      // Remove all malformed event triggers (type=event but missing event_date)
      for (let i = deferredTriggers.length - 1; i >= 0; i--) {
        const dt = deferredTriggers[i];
        if (
          dt.newNodeIndex === nodeIndex &&
          dt.trigger.type === "event" &&
          dt.trigger.eventDate == null
        ) {
          deferredTriggers.splice(i, 1);
        }
      }

      deferredTriggers.push({
        newNodeIndex: nodeIndex,
        trigger: {
          type: "event" as TriggerType,
          schedule: null,
          condition: null,
          conditionEmbedding: null,
          threshold: null,
          eventDate: node.eventDate,
          rampDays: 7,
          followUpDays: 2,
          recurring: false,
          consumed: false,
          cooldownMs: null,
          lastFired: null,
        },
      });
    }

    // Parse image refs
    if (Array.isArray(raw.image_refs)) {
      const validRefs: ImageRef[] = [];
      for (const ref of raw.image_refs) {
        if (!ref.message_id || typeof ref.message_id !== "string") continue;
        if (typeof ref.block_index !== "number" || ref.block_index < 0)
          continue;
        if (!ref.description || typeof ref.description !== "string") continue;
        const mimeType = resolveImageRefMimeType(
          ref.message_id,
          ref.block_index,
          conversationId,
        );
        if (!mimeType) continue;
        validRefs.push({
          messageId: ref.message_id,
          blockIndex: ref.block_index,
          description: ref.description,
          mimeType,
        });
      }
      node.imageRefs = validRefs.length > 0 ? validRefs : null;
    }
  }

  // Build temp_id → diff.createNodes-index map from nodes that passed
  // validation. A temp_id that collides with an existing candidate ID is
  // skipped so real IDs win on lookup — the prompt instructs the LLM to
  // choose distinctive values so this should be rare.
  const tempIdToDiffIndex = new Map<string, number>();
  for (let i = 0; i < createNodes.length; i++) {
    const raw = createNodes[i];
    const tempId = raw?.temp_id;
    if (typeof tempId !== "string" || tempId.length === 0) continue;
    if (candidateNodeIds.has(tempId)) continue;
    if (tempIdToDiffIndex.has(tempId)) continue; // first writer wins
    const diffIndex = rawIndexToDiffIndex.get(i);
    if (diffIndex == null) continue; // raw node was rejected during validation
    tempIdToDiffIndex.set(tempId, diffIndex);
  }

  const resolveEndpoint = (id: string): DeferredEdgeEndpoint | null => {
    if (candidateNodeIds.has(id)) return { kind: "existing", nodeId: id };
    const idx = tempIdToDiffIndex.get(id);
    if (idx != null) return { kind: "new", newNodeIndex: idx };
    return null;
  };

  const pushResolvedEdge = (
    source: DeferredEdgeEndpoint,
    target: DeferredEdgeEndpoint,
    relationship: string,
    weight: number,
  ) => {
    // Both endpoints existing → apply directly via diff.createEdges.
    // Otherwise defer until new node IDs are known post-applyDiff.
    if (source.kind === "existing" && target.kind === "existing") {
      diff.createEdges.push({
        sourceNodeId: source.nodeId,
        targetNodeId: target.nodeId,
        relationship: relationship as NewEdge["relationship"],
        weight,
        created: now,
      });
    } else {
      deferredEdges.push({ source, target, relationship, weight });
    }
  };

  // Second pass: resolve edges_to_existing on each raw create_nodes entry.
  // The source is always the containing new node; the target may be either
  // an existing candidate or a sibling new node referenced by temp_id.
  for (let i = 0; i < createNodes.length; i++) {
    const raw = createNodes[i];
    const sourceDiffIndex = rawIndexToDiffIndex.get(i);
    if (sourceDiffIndex == null) continue;
    if (!Array.isArray(raw.edges_to_existing)) continue;

    for (const edge of raw.edges_to_existing) {
      if (!edge.target_node_id) continue;
      if (!edge.relationship || !VALID_RELATIONSHIPS.has(edge.relationship))
        continue;
      const target = resolveEndpoint(edge.target_node_id);
      if (!target) continue;
      const source: DeferredEdgeEndpoint = {
        kind: "new",
        newNodeIndex: sourceDiffIndex,
      };
      // Skip self-loops.
      if (target.kind === "new" && target.newNodeIndex === sourceDiffIndex)
        continue;
      pushResolvedEdge(
        source,
        target,
        edge.relationship,
        clamp(Number(edge.weight) || 1.0, 0, 1),
      );
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
    if (raw.event_date !== undefined)
      changes.eventDate = parseEpochMs(raw.event_date);
    if (Object.keys(changes).length > 0) {
      diff.updateNodes.push({ id: raw.id, changes });
    }
  }

  // Parse top-level edges — each endpoint may be an existing candidate ID or
  // the temp_id of a new node declared in create_nodes.
  for (const raw of newEdges) {
    if (!raw.source_node_id || !raw.target_node_id) continue;
    if (!raw.relationship || !VALID_RELATIONSHIPS.has(raw.relationship))
      continue;
    const source = resolveEndpoint(raw.source_node_id);
    const target = resolveEndpoint(raw.target_node_id);
    if (!source || !target) continue;
    // Skip self-loops.
    if (
      source.kind === "new" &&
      target.kind === "new" &&
      source.newNodeIndex === target.newNodeIndex
    )
      continue;
    if (
      source.kind === "existing" &&
      target.kind === "existing" &&
      source.nodeId === target.nodeId
    )
      continue;
    pushResolvedEdge(
      source,
      target,
      raw.relationship,
      clamp(Number(raw.weight) || 1.0, 0, 1),
    );
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

  // 1. Load transcript — try multimodal first, fall back to text-only
  const imageResult = loadTranscriptWithImages(
    conversationId,
    opts?.afterTimestamp,
  );

  let transcript = opts?.transcript;
  if (!transcript) {
    transcript =
      loadTranscriptFromDisk(conversationId, opts?.afterTimestamp) ?? undefined;
    if (!transcript) {
      // If we have a multimodal result but no disk transcript, extract text
      // from the multimodal message content blocks for candidate search.
      if (imageResult) {
        transcript = imageResult.message.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n");
      }
      if (!transcript) {
        log.warn(
          { conversationId },
          "No transcript found on disk, skipping extraction",
        );
        return emptyResult;
      }
    }
  }

  // Skip very short conversations (< 100 chars)
  if (transcript.trim().length < 100) {
    return emptyResult;
  }

  // 2. Get provider
  const provider = await getConfiguredProvider("memoryExtraction");
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

  const activeSet = opts?.activeContextNodeIds
    ? new Set(opts.activeContextNodeIds)
    : undefined;

  const systemPrompt = buildGraphExtractionSystemPrompt(
    candidateNodes.map((n) => ({ id: n.id, type: n.type, content: n.content })),
    identityContext,
    activeSet,
  );

  // 5. Resolve conversation timestamp before the LLM call so we can include
  //    the date in the prompt — without it the model can't resolve "today"
  //    or correctly date events mentioned in the conversation.
  const conversationTimestamp =
    opts?.conversationTimestamp ??
    resolveConversationTimestamp(conversationId) ??
    imageResult?.lastTimestamp ??
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

  // 6. LLM call — use multimodal message when images are present
  const useMultimodal = imageResult?.hasImages === true;

  const extractionMessages: Message[] = useMultimodal
    ? [
        {
          role: "user",
          content: [
            {
              type: "text" as const,
              text: `## Conversation Date\n\n${conversationDate}\n\n## Conversation Transcript\n\n`,
            },
            ...imageResult.message.content,
          ],
        },
      ]
    : [
        userMessage(
          `## Conversation Date\n\n${conversationDate}\n\n## Conversation Transcript\n\n${transcript}`,
        ),
      ];

  const response = await provider.sendMessage(
    extractionMessages,
    [EXTRACT_TOOL_SCHEMA],
    systemPrompt,
    {
      config: {
        callSite: "memoryExtraction" as const,
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
  // TODO: full supersession is not yet implemented. When it lands, iterate
  // BOTH `diff.createEdges` (existing → existing) AND `deferredEdges`
  // (new → existing, the typical supersession case).
  // Tracked by https://github.com/vellum-ai/vellum-assistant/pull/27057 (Devin).
  for (const edge of diff.createEdges) {
    if (edge.relationship === "supersedes") {
      // Placeholder — see TODO above.
    }
  }
  for (const de of deferredEdges) {
    if (de.relationship === "supersedes") {
      // Placeholder — see TODO above.
    }
  }

  // 8. Apply the diff
  const result = applyDiff(diff, { conversationId });

  // 9. Apply deferred edges and triggers using the created node IDs
  const createdNodeIds = result.createdNodeIds;
  let edgesCreated = result.edgesCreated;
  let triggersCreated = result.triggersCreated;

  const resolveCreatedEndpoint = (ep: DeferredEdgeEndpoint): string | null => {
    if (ep.kind === "existing") return ep.nodeId;
    return createdNodeIds[ep.newNodeIndex] ?? null;
  };

  for (const de of deferredEdges) {
    const sourceNodeId = resolveCreatedEndpoint(de.source);
    const targetNodeId = resolveCreatedEndpoint(de.target);
    if (!sourceNodeId || !targetNodeId) continue;

    createEdge({
      sourceNodeId,
      targetNodeId,
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

function resolveImageRefMimeType(
  messageId: string,
  blockIndex: number,
  conversationId: string,
): string | null {
  const db = getDb();
  const msg = db
    .select({ content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.conversationId, conversationId),
      ),
    )
    .get();
  if (!msg) return null;

  try {
    const blocks = JSON.parse(msg.content) as Array<{
      type?: string;
      source?: { media_type?: string };
    }>;
    const block = blocks[blockIndex];
    if (!block || block.type !== "image") return null;
    return block.source?.media_type ?? null;
  } catch {
    return null;
  }
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

/**
 * Load a conversation transcript from the DB with interleaved text and image
 * content blocks.  Returns a single consolidated `Message` with role "user"
 * containing text annotations and `ImageContent` blocks so the extraction LLM
 * can see images alongside their textual context.
 *
 * Images are capped at 10 per transcript to control extraction cost.
 */
function loadTranscriptWithImages(
  conversationId: string,
  afterTimestamp?: number,
): {
  message: Message;
  hasImages: boolean;
  lastTimestamp: number | null;
} | null {
  const db = getDb();

  // Build query conditions
  const conditions = [eq(messages.conversationId, conversationId)];
  if (afterTimestamp !== undefined) {
    conditions.push(gt(messages.createdAt, afterTimestamp));
  }

  const rows = db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(...conditions))
    .orderBy(asc(messages.createdAt))
    .all();

  if (rows.length === 0) return null;

  const MAX_IMAGES = 10;
  let imageCount = 0;
  let hasImagesFlag = false;
  let totalTextLength = 0;
  let lastTimestamp: number | null = null;

  const contentBlocks: ContentBlock[] = [];

  for (const row of rows) {
    lastTimestamp = row.createdAt;

    let parsed: ContentBlock[];
    try {
      const raw = JSON.parse(row.content) as unknown;
      if (typeof raw === "string") {
        parsed = [{ type: "text", text: raw }];
      } else if (Array.isArray(raw)) {
        parsed = raw as ContentBlock[];
      } else {
        continue;
      }
    } catch {
      // If content is a plain string (not JSON), wrap it
      parsed = [{ type: "text", text: row.content }];
    }

    // Build content blocks preserving original text/image interleaving
    let prefixAdded = false;
    for (let i = 0; i < parsed.length; i++) {
      const block = parsed[i];
      if (block?.type === "text") {
        const rawText = typeof block.text === "string" ? block.text : "";
        const text = prefixAdded ? rawText : `[${row.role}]: ${rawText}`;
        prefixAdded = true;
        totalTextLength += text.length;
        contentBlocks.push({ type: "text", text });
      } else if (block?.type === "image") {
        if (imageCount < MAX_IMAGES) {
          const imgBlock = block as ImageContent;
          // Add annotation so the extraction LLM knows the image's reference coordinates
          contentBlocks.push({
            type: "text",
            text: `<image message_id="${row.id}" block_index="${i}" type="${imgBlock.source.media_type}" />`,
          });
          contentBlocks.push(imgBlock);
          imageCount++;
          hasImagesFlag = true;
        }
        // After cap, skip image blocks but continue processing text
      }
    }
  }

  // Skip if transcript is too short (images count toward the threshold)
  if (totalTextLength < 100 && !hasImagesFlag) return null;

  const message: Message = {
    role: "user",
    content: contentBlocks,
  };

  return { message, hasImages: hasImagesFlag, lastTimestamp };
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
