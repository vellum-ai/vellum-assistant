// ---------------------------------------------------------------------------
// Memory Graph — Core type definitions
// ---------------------------------------------------------------------------

/** Classification of what kind of memory a node represents. */
export type MemoryType =
  | "episodic" // specific moments, conversations, events
  | "semantic" // facts, knowledge, understanding
  | "procedural" // learned skills, how-to knowledge
  | "emotional" // feelings attached to memories
  | "prospective" // future-oriented, things to remember to do
  | "behavioral" // things that change how the assistant acts going forward
  | "narrative" // the story a memory becomes over time
  | "shared"; // memories that belong to a relationship, not either party

/** How detailed the memory is — degrades over time via consolidation. */
export type Fidelity = "vivid" | "clear" | "faded" | "gist" | "gone";

/** Shape of emotional intensity decay over time. */
export type DecayCurve =
  | "linear" // constant rate of decay
  | "logarithmic" // sharp initial drop, long tail (negative events)
  | "transformative" // feeling changes shape, not just intensity (positive milestones)
  | "permanent"; // no decay (core identity markers)

/** How the memory was originally acquired. */
export type SourceType =
  | "direct" // user explicitly stated it
  | "inferred" // assistant derived it from context
  | "observed" // assistant noticed a pattern
  | "told-by-other"; // third party provided it

/** Reference to an image stored in a conversation message. */
export interface ImageRef {
  /** Message ID containing the image. */
  messageId: string;
  /** Index of the image ContentBlock within the message's content array. */
  blockIndex: number;
  /** LLM-generated description of what the image shows. */
  description: string;
  /** MIME type (image/png, image/jpeg, etc). */
  mimeType: string;
}

/** Emotional charge attached to a memory — decays independently from the memory itself. */
export interface EmotionalCharge {
  /** Positive vs negative sentiment (-1 to 1). */
  valence: number;
  /** Current emotional intensity (0 to 1). Decays per the curve. */
  intensity: number;
  /** Shape of the decay function. */
  decayCurve: DecayCurve;
  /** Rate parameter for decay (higher = faster). */
  decayRate: number;
  /** What the intensity was when the memory was created. */
  originalIntensity: number;
}

// ---------------------------------------------------------------------------
// Graph primitives
// ---------------------------------------------------------------------------

export interface MemoryNode {
  id: string;

  /** First-person prose — how the assistant naturally remembers this. */
  content: string;
  type: MemoryType;

  // -- Temporal --
  /** Epoch ms when the memory was created. Hour/day/month are derived at query time. */
  created: number;
  /** Epoch ms — used ONLY as a decay-rate modifier, NOT a retrieval signal. */
  lastAccessed: number;
  /** Epoch ms of last consolidation pass that touched this node. */
  lastConsolidated: number;
  /** Epoch ms of the event this memory describes (null for non-event memories). */
  eventDate: number | null;

  // -- Energy --
  emotionalCharge: EmotionalCharge;
  fidelity: Fidelity;
  /** How sure the assistant is this memory is accurate (0–1). */
  confidence: number;
  /** How important this memory is (0–1). Subject to Ebbinghaus decay. */
  significance: number;

  // -- Reinforcement (Ebbinghaus forgetting curve) --
  /** Resistance to significance decay. Grows with reinforcement (×1.5 per reinforcement). */
  stability: number;
  /** How many times this memory has been confirmed/reinforced. */
  reinforcementCount: number;
  /** Epoch ms of last reinforcement event. */
  lastReinforced: number;

  // -- Provenance --
  /** Conversation IDs that contributed to this memory. */
  sourceConversations: string[];
  sourceType: SourceType;

  // -- Narrative --
  /** Role in a larger story arc (e.g. "turning-point", "foreshadowing"). */
  narrativeRole: string | null;
  /** Which story arc this belongs to. */
  partOfStory: string | null;

  /** Image references attached to this memory (null if text-only). */
  imageRefs: ImageRef[] | null;

  /** Memory scope for multi-scope isolation. */
  scopeId: string;
}

/**
 * Whether a node is an auto-seeded capability (skill or CLI command) rather
 * than an organically-extracted procedural memory. Capability nodes are
 * created by the seeding systems at startup; organic procedural nodes are
 * extracted from conversations (e.g. "FFmpeg needs -ac 2 for stereo").
 *
 * Only capability nodes should be reserved/excluded from normal retrieval
 * and consolidation — organic procedural nodes participate normally.
 */
export function isCapabilityNode(node: MemoryNode): boolean {
  if (node.type !== "procedural") return false;
  // Old seeding system (skill-memory.ts): content starts with "skill:{id}\n"
  if (node.content.startsWith("skill:")) return true;
  // New seeding system (capability-seed.ts): content matches
  // 'The "{name}" skill ({id}) is available.' or
  // 'The "assistant {name}" CLI command is available.'
  if (
    node.content.startsWith('The "') &&
    node.content.includes(") is available.")
  ) {
    return true;
  }
  return false;
}

/** Relationship type between two memory nodes. */
export type EdgeRelationship =
  | "caused-by"
  | "reminds-of"
  | "contradicts"
  | "depends-on"
  | "part-of"
  | "supersedes"
  | "resolved-by";

export interface MemoryEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationship: EdgeRelationship;
  /** Connection strength (0–1). */
  weight: number;
  /** Epoch ms. */
  created: number;
}

/** Trigger type determines how the trigger condition is evaluated. */
export type TriggerType = "temporal" | "semantic" | "event";

export interface MemoryTrigger {
  id: string;
  /** Which memory node this trigger belongs to. */
  nodeId: string;
  type: TriggerType;

  // -- Temporal triggers --
  /** Cron-like pattern: "day-of-week:monday", "date:04-08", "time:morning". */
  schedule: string | null;

  // -- Semantic triggers --
  /** Natural language condition: "user graduates", "topic of cooking comes up". */
  condition: string | null;
  /** Pre-computed embedding of the condition text for fast cosine similarity. */
  conditionEmbedding: Float32Array | null;
  /** Cosine similarity threshold to fire (0–1). */
  threshold: number | null;

  // -- Event triggers --
  /** Epoch ms of the event date. */
  eventDate: number | null;
  /** Days before the event to start ramping relevance. */
  rampDays: number | null;
  /** Days after the event to maintain elevated relevance. */
  followUpDays: number | null;

  // -- State --
  /** Whether this trigger fires repeatedly or is consumed on first fire. */
  recurring: boolean;
  /** Whether a one-shot trigger has already fired. */
  consumed: boolean;
  /** Minimum ms between firings for recurring triggers. */
  cooldownMs: number | null;
  /** Epoch ms of last firing. */
  lastFired: number | null;
}

// ---------------------------------------------------------------------------
// Diff — the extraction/consolidation output format
// ---------------------------------------------------------------------------

/** A node to be created (id assigned by store). */
export type NewNode = Omit<MemoryNode, "id">;

/** Partial update to an existing node. */
export interface NodeUpdate {
  id: string;
  changes: Partial<Omit<MemoryNode, "id">>;
}

/** A new edge to create (id assigned by store). */
export type NewEdge = Omit<MemoryEdge, "id">;

/** A new trigger to create (id assigned by store). */
export type NewTrigger = Omit<MemoryTrigger, "id">;

/**
 * The atomic diff that extraction/consolidation produces.
 * Applied transactionally to the graph store.
 */
export interface MemoryDiff {
  createNodes: NewNode[];
  updateNodes: NodeUpdate[];
  deleteNodeIds: string[];
  createEdges: NewEdge[];
  deleteEdgeIds: string[];
  createTriggers: NewTrigger[];
  deleteTriggerIds: string[];
  /** Node IDs that were reinforced (confirmed/validated) by this extraction. */
  reinforceNodeIds: string[];
}

// ---------------------------------------------------------------------------
// Scored candidates — used by retrieval pipeline
// ---------------------------------------------------------------------------

export interface ScoredNode {
  node: MemoryNode;
  /** Combined retrieval score (higher = more relevant right now). */
  score: number;
  /** Breakdown of score components for debugging/inspection. */
  scoreBreakdown: {
    semanticSimilarity: number;
    effectiveSignificance: number;
    emotionalIntensity: number;
    temporalBoost: number;
    recencyBoost: number;
    triggerBoost: number;
    activationBoost: number;
  };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ApplyDiffResult {
  nodesCreated: number;
  nodesUpdated: number;
  nodesDeleted: number;
  edgesCreated: number;
  edgesDeleted: number;
  triggersCreated: number;
  triggersDeleted: number;
  nodesReinforced: number;
  /** IDs of newly created nodes (in order of diff.createNodes). */
  createdNodeIds: string[];
}
