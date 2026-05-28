export type LeafPath = string; // dot- or slash-pathed taxonomy node
export type Slug = string;

export interface LeafFrontmatter {
  path: LeafPath;
  in_core: boolean;
}

export interface LeafNode {
  path: LeafPath;
  frontmatter: LeafFrontmatter;
  description: string;
  members: Slug[];
  domain: string;
}

export interface LeafTree {
  leaves: Map<LeafPath, LeafNode>;
  byPage: Map<Slug, LeafPath[]>;
}

export interface WorkingSetEntry {
  slug: Slug;
  selectedAtTurn: number;
  pinned: boolean;
  lastSeenTurn: number;
}

export interface TurnContext {
  conversationId: string;
  turnNumber: number;
  currentMessage: string;
  recentContext: string;
}

export type SelectionSource = "l1+l2" | "core+l2" | "needle" | "carry-forward";
