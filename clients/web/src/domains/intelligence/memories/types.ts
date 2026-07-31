export type MemoryKind =
  | "episodic"
  | "semantic"
  | "procedural"
  | "emotional"
  | "prospective"
  | "behavioral"
  | "narrative"
  | "shared";

export type MemoryStatus = "active" | "inactive";

export type MemoryStatusFilter = "active" | "inactive" | "all";

export type MemorySortOption = "newest" | "oldest" | "importance" | "kind";

export interface EmotionalCharge {
  valence?: number | null;
  intensity?: number | null;
  decayCurve?: string | null;
  decayRate?: number | null;
  originalIntensity?: number | null;
}

export interface MemoryItem {
  id: string;
  kind: string;
  subject: string;
  statement: string;
  status: string;
  confidence?: number | null;
  importance?: number | null;
  firstSeenAt: number;
  lastSeenAt: number;

  fidelity?: string | null;
  sourceType?: string | null;
  narrativeRole?: string | null;
  partOfStory?: string | null;
  reinforcementCount?: number | null;
  stability?: number | null;
  emotionalCharge?: EmotionalCharge | null;

  accessCount?: number | null;
  verificationState?: string | null;
  lastUsedAt?: number | null;
  supersedes?: string | null;
  supersededBy?: string | null;
  supersedesSubject?: string | null;
  supersededBySubject?: string | null;
}

export interface MemoryItemsListResponse {
  items: MemoryItem[];
  total: number;
  kindCounts?: Record<string, number>;
}

export function sourceTypeLabel(sourceType?: string | null): string | null {
  switch (sourceType) {
    case "direct":
      return "Told directly";
    case "observed":
      return "Observed";
    case "inferred":
      return "Inferred";
    case "told-by-other":
      return "Told by other";
    default:
      return null;
  }
}
