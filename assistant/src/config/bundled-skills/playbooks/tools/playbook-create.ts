import { sql } from "drizzle-orm";

import { getDb } from "../../../../memory/db-connection.js";
import { createNode, updateNode } from "../../../../memory/graph/store.js";
import type { NewNode } from "../../../../memory/graph/types.js";
import { enqueueMemoryJob } from "../../../../memory/jobs-store.js";
import { memoryGraphNodes } from "../../../../memory/schema.js";
import type {
  Playbook,
  PlaybookAutonomyLevel,
} from "../../../../playbooks/types.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

const VALID_AUTONOMY_LEVELS = new Set<string>(["auto", "draft", "notify"]);

export async function executePlaybookCreate(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const trigger = input.trigger as string;
  const action = input.action as string;

  if (!trigger || typeof trigger !== "string") {
    return {
      content: "Error: trigger is required and must be a string",
      isError: true,
    };
  }
  if (!action || typeof action !== "string") {
    return {
      content: "Error: action is required and must be a string",
      isError: true,
    };
  }

  const channel = typeof input.channel === "string" ? input.channel : "*";
  const category =
    typeof input.category === "string" ? input.category : "general";
  const autonomyLevel: PlaybookAutonomyLevel =
    typeof input.autonomy_level === "string" &&
    VALID_AUTONOMY_LEVELS.has(input.autonomy_level)
      ? (input.autonomy_level as PlaybookAutonomyLevel)
      : "draft";
  const priority = typeof input.priority === "number" ? input.priority : 0;

  const playbook: Playbook = {
    trigger,
    channel,
    category,
    action,
    autonomyLevel,
    priority,
  };
  const statement = JSON.stringify(playbook);
  const sanitizedTrigger = trigger.replace(/[\r\n]+/g, " ");
  const subject = `Playbook: ${sanitizedTrigger}`.slice(0, 80);
  const content = `${subject}\n${statement}`;
  const scopeId = "default";

  try {
    const db = getDb();

    // Check for duplicate by matching content in playbook-prefixed graph nodes
    const existing = db
      .select({ id: memoryGraphNodes.id })
      .from(memoryGraphNodes)
      .where(
        sql`${memoryGraphNodes.sourceConversations} LIKE '%playbook:%'
            AND ${memoryGraphNodes.content} = ${content}
            AND ${memoryGraphNodes.scopeId} = ${scopeId}
            AND ${memoryGraphNodes.fidelity} != 'gone'`,
      )
      .get();

    if (existing) {
      return {
        content: `A playbook with this exact configuration already exists (ID: ${existing.id}).`,
        isError: false,
      };
    }

    const now = Date.now();
    const newNode: NewNode = {
      content,
      type: "semantic",
      created: now,
      lastAccessed: now,
      lastConsolidated: now,
      eventDate: null,
      emotionalCharge: {
        valence: 0,
        intensity: 0.1,
        decayCurve: "linear",
        decayRate: 0.05,
        originalIntensity: 0.1,
      },
      fidelity: "vivid",
      confidence: 0.95,
      significance: 0.8,
      stability: 14,
      reinforcementCount: 0,
      lastReinforced: now,
      sourceConversations: [],
      sourceType: "direct",
      narrativeRole: null,
      partOfStory: null,
      imageRefs: null,
      scopeId,
    };

    const node = createNode(newNode);
    updateNode(node.id, {
      sourceConversations: [`playbook:${node.id}`],
    });

    enqueueMemoryJob("embed_graph_node", { nodeId: node.id });

    const autonomyLabel =
      autonomyLevel === "auto"
        ? "execute automatically"
        : autonomyLevel === "draft"
          ? "draft for review"
          : "notify only";

    return {
      content: [
        "Playbook created successfully.",
        `  ID: ${node.id}`,
        `  Trigger: ${trigger}`,
        `  Channel: ${channel}`,
        `  Category: ${category}`,
        `  Action: ${action}`,
        `  Autonomy: ${autonomyLabel}`,
        `  Priority: ${priority}`,
      ].join("\n"),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error creating playbook: ${msg}`, isError: true };
  }
}

export { executePlaybookCreate as run };
