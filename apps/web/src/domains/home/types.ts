export type FeedItemType = "notification";
export type FeedItemStatus = "new" | "seen" | "acted_on" | "dismissed";
export type FeedItemUrgency = "low" | "medium" | "high" | "critical";
export type FeedItemCategory =
  | "security"
  | "scheduling"
  | "background"
  | "email"
  | "system";

export type FeedItemDetailPanelKind =
  | "emailDraft"
  | "documentPreview"
  | "permissionChat"
  | "paymentAuth"
  | "toolPermission"
  | "updatesList";

export interface FeedAction {
  id: string;
  label: string;
  prompt: string;
}

export interface FeedItemDetailPanel {
  kind: FeedItemDetailPanelKind;
}

export interface FeedItem {
  id: string;
  type: FeedItemType;
  priority: number;
  title: string;
  summary: string;
  timestamp: string;
  status: FeedItemStatus;
  expiresAt?: string;
  actions?: FeedAction[];
  urgency?: FeedItemUrgency;
  conversationId?: string;
  detailPanel?: FeedItemDetailPanel;
  category?: FeedItemCategory;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export type SuggestedPromptSource = "deterministic" | "assistant";
export interface SuggestedPrompt {
  id: string;
  label: string;
  icon?: string;
  prompt: string;
  source: SuggestedPromptSource;
}

export interface ContextBanner {
  greeting: string;
  timeAwayLabel: string;
  newCount: number;
}

export interface HomeFeedResponse {
  items: FeedItem[];
  updatedAt: string;
  contextBanner: ContextBanner;
  suggestedPrompts: SuggestedPrompt[];
}

export type RelationshipTier = 1 | 2 | 3 | 4;
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
  gate: string;
  unlockHint?: string;
  ctaLabel?: string;
}

export interface RelationshipState {
  version: number;
  assistantId: string;
  tier: RelationshipTier;
  progressPercent: number;
  facts: Fact[];
  capabilities: Capability[];
  conversationCount: number;
  hatchedDate: string;
  assistantName: string;
  userName?: string;
  updatedAt: string;
}

export type FeedTimeGroup = "today" | "yesterday" | "older";
