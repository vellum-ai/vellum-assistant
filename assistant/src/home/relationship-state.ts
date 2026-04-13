/**
 * Relationship state data contract.
 *
 * This is the shared wire format that describes the assistant's current
 * relationship with the user: which tier they're at, what facts the
 * assistant has learned about them, and which capabilities are unlocked.
 *
 * The TypeScript types here are the source of truth. A structurally
 * identical Swift definition lives at
 * `clients/shared/Models/RelationshipState.swift` — any change here must
 * be mirrored there (and the contract test guards the default list).
 */

export const RELATIONSHIP_STATE_VERSION = 1 as const;

export type RelationshipTier = 1 | 2 | 3 | 4;

export interface TierInfo {
  label: string;
  description: string;
  nextTierHint?: string;
}

export const TIER_INFO: Record<RelationshipTier, TierInfo> = {
  1: {
    label: "Getting to know you",
    description: "We just met — learning the basics",
    nextTierHint: "A few more conversations and I'll start to find my footing",
  },
  2: {
    label: "Finding my footing",
    description: "Starting to understand how you work",
    nextTierHint: "Keep working with me and we'll hit our stride",
  },
  3: {
    label: "Hitting our stride",
    description: "We have a real working relationship",
    nextTierHint:
      "Give me more context and autonomy and we'll be fully in sync",
  },
  4: {
    label: "In sync",
    description: "Full partnership",
  },
};

export type FactCategory = "voice" | "world" | "priorities";
export type FactConfidence = "strong" | "uncertain";
export type FactSource = "onboarding" | "inferred";

export interface Fact {
  id: string;
  category: FactCategory;
  text: string;
  confidence: FactConfidence;
  source: FactSource;
}

export type CapabilityTier = "unlocked" | "next-up" | "earned";

export interface Capability {
  id: string;
  name: string;
  description: string;
  tier: CapabilityTier;
  /** Human-readable unlock requirement. */
  gate: string;
  /** Shown on "earned" tier: why, not when. */
  unlockHint?: string;
  /** Shown on "next-up" tier: e.g. "Connect Google →". */
  ctaLabel?: string;
}

export interface RelationshipState {
  version: typeof RELATIONSHIP_STATE_VERSION;
  /** Forward-compat for multi-assistant. Only one assistant is supported in v1. */
  assistantId: string;
  tier: RelationshipTier;
  /** 0-100 */
  progressPercent: number;
  facts: Fact[];
  capabilities: Capability[];
  conversationCount: number;
  /** ISO 8601 */
  hatchedDate: string;
  assistantName: string;
  userName?: string;
  /** ISO 8601 */
  updatedAt: string;
}

/**
 * Seed list of capabilities the relationship-state writer should project,
 * minus the `tier` field (which is computed at write time based on what
 * the assistant has learned and which integrations are connected).
 *
 * Order and ids are part of the public contract — the contract test
 * asserts this list matches the TDD so drift causes a failure.
 */
export const DEFAULT_CAPABILITIES: Omit<Capability, "tier">[] = [
  {
    id: "email",
    name: "Email access",
    description: "Read, draft, and manage your email",
    gate: "Connect Google or Outlook",
    ctaLabel: "Connect Google →",
  },
  {
    id: "calendar",
    name: "Calendar awareness",
    description: "Know your schedule, prep for meetings",
    gate: "Connect calendar",
    ctaLabel: "Connect Calendar →",
  },
  {
    id: "slack",
    name: "Slack monitoring",
    description: "Watch channels, surface what matters",
    gate: "Set up Slack app",
    ctaLabel: "Set up Slack →",
  },
  {
    id: "voice-writing",
    name: "Write in your voice",
    description: "Draft messages and docs that sound like you",
    gate: "Usage — needs conversation history",
    unlockHint: "I need to learn how you communicate first",
  },
  {
    id: "proactive",
    name: "Proactive suggestions",
    description: "Flag things before you ask",
    gate: "Trust — needs priority understanding",
    unlockHint: "I need to understand your priorities first",
  },
  {
    id: "autonomous",
    name: "Act on your behalf",
    description: "Send messages, file things, take action",
    gate: "Trust — deepest level",
    unlockHint: "We need a deeper working relationship first",
  },
];
