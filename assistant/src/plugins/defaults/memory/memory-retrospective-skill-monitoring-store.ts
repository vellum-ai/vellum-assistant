import { and, asc, desc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import {
  memoryRetrospectiveSkillCandidates,
  memoryRetrospectiveSkillChanges,
  memoryRetrospectiveSkillSearches,
} from "../../../persistence/schema/index.js";
import { memoryDbOrNull } from "./memory-db.js";

export type MemoryRetrospectiveSkillCandidateDecision =
  | "selected"
  | "not_selected";

export type MemoryRetrospectiveSkillSearchOutcome =
  | "created"
  | "refined"
  | "covered"
  | "skipped";

export type MemoryRetrospectiveSkillSystemExclusionReason =
  | "out_of_plugin_scope"
  | "incompatible_platform"
  | "below_shortlist_threshold"
  | "below_shortlist_limit"
  | "scorer_failed"
  | "no_score_returned";

export interface MemoryRetrospectiveSkillCandidateInput {
  skillId: string;
  skillName: string;
  skillDescription: string;
  skillSource: string;
  skillAuthor?: string;
  considerationStatus: "surfaced" | "excluded";
  systemExclusionReason?: MemoryRetrospectiveSkillSystemExclusionReason;
  rank?: number;
  score?: number;
}

export interface MemoryRetrospectiveSkillDecisionInput {
  skillId: string;
  decision: MemoryRetrospectiveSkillCandidateDecision;
  reason: string;
}

export interface MemoryRetrospectiveSkillChangeInput {
  id?: string;
  searchId: string;
  conversationId: string;
  runConversationId: string;
  skillId: string;
  operation: "created" | "refined";
  delta: string;
  createdAt?: number;
}

/** Persist one search and the exact shortlist returned to the retrospective. */
export function recordMemoryRetrospectiveSkillSearch(args: {
  id: string;
  conversationId: string;
  runConversationId: string;
  goal: string;
  candidates: MemoryRetrospectiveSkillCandidateInput[];
  createdAt?: number;
}): boolean {
  const db = memoryDbOrNull("recordMemoryRetrospectiveSkillSearch");
  if (!db) {
    return false;
  }
  const createdAt = args.createdAt ?? Date.now();
  db.transaction((tx) => {
    tx.insert(memoryRetrospectiveSkillSearches)
      .values({
        id: args.id,
        conversationId: args.conversationId,
        runConversationId: args.runConversationId,
        goal: args.goal,
        createdAt,
      })
      .onConflictDoNothing()
      .run();
    for (const candidate of args.candidates) {
      tx.insert(memoryRetrospectiveSkillCandidates)
        .values({
          id: uuidv7(),
          searchId: args.id,
          conversationId: args.conversationId,
          runConversationId: args.runConversationId,
          skillId: candidate.skillId,
          skillName: candidate.skillName,
          skillDescription: candidate.skillDescription,
          skillSource: candidate.skillSource,
          skillAuthor: candidate.skillAuthor ?? null,
          considerationStatus: candidate.considerationStatus,
          systemExclusionReason: candidate.systemExclusionReason ?? null,
          rank: candidate.rank ?? null,
          score: candidate.score ?? null,
          createdAt,
        })
        .onConflictDoNothing()
        .run();
    }
  });
  return true;
}

/** Record the retrospective's explicit selection reason for every candidate. */
export function recordMemoryRetrospectiveSkillDecisions(args: {
  searchId: string;
  runConversationId: string;
  outcome: MemoryRetrospectiveSkillSearchOutcome;
  reason: string;
  decisions: MemoryRetrospectiveSkillDecisionInput[];
  decidedAt?: number;
}): boolean {
  const db = memoryDbOrNull("recordMemoryRetrospectiveSkillDecisions");
  if (!db) {
    return false;
  }
  const search = db
    .select({ id: memoryRetrospectiveSkillSearches.id })
    .from(memoryRetrospectiveSkillSearches)
    .where(
      and(
        eq(memoryRetrospectiveSkillSearches.id, args.searchId),
        eq(
          memoryRetrospectiveSkillSearches.runConversationId,
          args.runConversationId,
        ),
      ),
    )
    .get();
  if (!search) {
    throw new Error("monitoring search not found for this retrospective run");
  }

  const candidates = db
    .select({
      skillId: memoryRetrospectiveSkillCandidates.skillId,
      skillSource: memoryRetrospectiveSkillCandidates.skillSource,
      skillAuthor: memoryRetrospectiveSkillCandidates.skillAuthor,
    })
    .from(memoryRetrospectiveSkillCandidates)
    .where(
      and(
        eq(memoryRetrospectiveSkillCandidates.searchId, args.searchId),
        eq(memoryRetrospectiveSkillCandidates.considerationStatus, "surfaced"),
      ),
    )
    .all();
  const expected = new Set(candidates.map((candidate) => candidate.skillId));
  const provided = new Set(args.decisions.map((decision) => decision.skillId));
  if (
    provided.size !== args.decisions.length ||
    expected.size !== provided.size ||
    [...expected].some((skillId) => !provided.has(skillId))
  ) {
    throw new Error(
      "decisions must contain exactly one entry for every returned candidate",
    );
  }

  const selected = args.decisions.filter(
    (decision) => decision.decision === "selected",
  );
  const selectedCount = selected.length;
  const expectedSelectedCount =
    args.outcome === "refined" || args.outcome === "covered" ? 1 : 0;
  if (selectedCount !== expectedSelectedCount) {
    throw new Error(
      `${args.outcome} requires ${expectedSelectedCount} selected candidate(s)`,
    );
  }
  if (args.outcome === "refined") {
    const selectedCandidate = candidates.find(
      (candidate) => candidate.skillId === selected[0]?.skillId,
    );
    if (
      selectedCandidate?.skillSource !== "managed" ||
      selectedCandidate.skillAuthor !== "assistant"
    ) {
      throw new Error(
        "refined requires one selected assistant-authored managed skill",
      );
    }
  }
  if (args.outcome === "created" || args.outcome === "refined") {
    const change = db
      .select({
        skillId: memoryRetrospectiveSkillChanges.skillId,
        operation: memoryRetrospectiveSkillChanges.operation,
      })
      .from(memoryRetrospectiveSkillChanges)
      .where(eq(memoryRetrospectiveSkillChanges.searchId, args.searchId))
      .get();
    if (!change || change.operation !== args.outcome) {
      throw new Error(
        `${args.outcome} requires a linked successful scaffold delta`,
      );
    }
    if (args.outcome === "refined" && change.skillId !== selected[0]?.skillId) {
      throw new Error(
        "refined decision must select the skill changed by the scaffold",
      );
    }
  }

  const decidedAt = args.decidedAt ?? Date.now();
  db.transaction((tx) => {
    tx.update(memoryRetrospectiveSkillSearches)
      .set({
        outcome: args.outcome,
        reason: args.reason,
        decidedAt,
      })
      .where(eq(memoryRetrospectiveSkillSearches.id, args.searchId))
      .run();
    for (const decision of args.decisions) {
      tx.update(memoryRetrospectiveSkillCandidates)
        .set({
          decision: decision.decision,
          reason: decision.reason,
          decidedAt,
        })
        .where(
          and(
            eq(memoryRetrospectiveSkillCandidates.searchId, args.searchId),
            eq(memoryRetrospectiveSkillCandidates.skillId, decision.skillId),
          ),
        )
        .run();
    }
  });
  return true;
}

/** Persist the exact file delta for a successful retrospective skill write. */
export function recordMemoryRetrospectiveSkillChange(
  args: MemoryRetrospectiveSkillChangeInput,
): boolean {
  const db = memoryDbOrNull("recordMemoryRetrospectiveSkillChange");
  if (!db) {
    return false;
  }
  const search = db
    .select({ id: memoryRetrospectiveSkillSearches.id })
    .from(memoryRetrospectiveSkillSearches)
    .where(
      and(
        eq(memoryRetrospectiveSkillSearches.id, args.searchId),
        eq(
          memoryRetrospectiveSkillSearches.conversationId,
          args.conversationId,
        ),
        eq(
          memoryRetrospectiveSkillSearches.runConversationId,
          args.runConversationId,
        ),
      ),
    )
    .get();
  if (!search) {
    throw new Error("monitoring search not found for this retrospective run");
  }
  if (args.operation === "created") {
    const candidate = db
      .select({ id: memoryRetrospectiveSkillCandidates.id })
      .from(memoryRetrospectiveSkillCandidates)
      .where(
        and(
          eq(memoryRetrospectiveSkillCandidates.searchId, args.searchId),
          eq(memoryRetrospectiveSkillCandidates.skillId, args.skillId),
        ),
      )
      .get();
    if (candidate) {
      throw new Error("created skill already existed in the linked evaluation");
    }
  }
  if (args.operation === "refined") {
    const candidate = db
      .select({ id: memoryRetrospectiveSkillCandidates.id })
      .from(memoryRetrospectiveSkillCandidates)
      .where(
        and(
          eq(memoryRetrospectiveSkillCandidates.searchId, args.searchId),
          eq(memoryRetrospectiveSkillCandidates.skillId, args.skillId),
          eq(
            memoryRetrospectiveSkillCandidates.considerationStatus,
            "surfaced",
          ),
        ),
      )
      .get();
    if (!candidate) {
      throw new Error("refined skill was not returned by the linked search");
    }
  }
  db.insert(memoryRetrospectiveSkillChanges)
    .values({
      id: args.id ?? uuidv7(),
      searchId: args.searchId,
      conversationId: args.conversationId,
      runConversationId: args.runConversationId,
      skillId: args.skillId,
      operation: args.operation,
      delta: args.delta,
      createdAt: args.createdAt ?? Date.now(),
    })
    .onConflictDoNothing()
    .run();
  return true;
}

/** Read the normalized rows a future Inspector view can join and render. */
export function getMemoryRetrospectiveSkillMonitoringForConversation(
  conversationId: string,
) {
  const db = memoryDbOrNull(
    "getMemoryRetrospectiveSkillMonitoringForConversation",
  );
  if (!db) {
    return null;
  }
  return {
    searches: db
      .select()
      .from(memoryRetrospectiveSkillSearches)
      .where(
        eq(memoryRetrospectiveSkillSearches.conversationId, conversationId),
      )
      .orderBy(
        asc(memoryRetrospectiveSkillSearches.createdAt),
        asc(memoryRetrospectiveSkillSearches.id),
      )
      .all(),
    candidates: db
      .select()
      .from(memoryRetrospectiveSkillCandidates)
      .where(
        eq(memoryRetrospectiveSkillCandidates.conversationId, conversationId),
      )
      .orderBy(
        asc(memoryRetrospectiveSkillCandidates.createdAt),
        desc(memoryRetrospectiveSkillCandidates.considerationStatus),
        asc(memoryRetrospectiveSkillCandidates.rank),
        asc(memoryRetrospectiveSkillCandidates.skillId),
      )
      .all(),
    changes: db
      .select()
      .from(memoryRetrospectiveSkillChanges)
      .where(eq(memoryRetrospectiveSkillChanges.conversationId, conversationId))
      .orderBy(
        asc(memoryRetrospectiveSkillChanges.createdAt),
        asc(memoryRetrospectiveSkillChanges.id),
      )
      .all(),
  };
}
