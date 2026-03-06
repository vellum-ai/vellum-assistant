// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

export interface TwitterUser {
  id: string;
  screenName: string;
  name: string;
  description?: string;
  profileImageUrl?: string;
  followersCount?: number;
  followingCount?: number;
}

export interface Tweet {
  id: string;
  text: string;
  authorId: string;
  authorScreenName?: string;
  authorName?: string;
  createdAt?: string;
  url?: string;
  replyCount?: number;
  retweetCount?: number;
  likeCount?: number;
  media?: TweetMedia[];
}

export interface TweetMedia {
  type: "photo" | "video" | "animated_gif";
  url: string;
  previewUrl?: string;
}

export interface Notification {
  id: string;
  message: string;
  timestamp?: string;
  url?: string;
}

export interface TwitterStatus {
  oauthConnected: boolean;
  browserSessionActive: boolean;
  preferredStrategy: "oauth" | "browser" | "auto";
  strategyConfigured: boolean;
  screenName?: string;
}

// ---------------------------------------------------------------------------
// Command Types
// ---------------------------------------------------------------------------

export type TwitterCommand =
  | "status"
  | "post"
  | "reply"
  | "timeline"
  | "tweet"
  | "search"
  | "bookmarks"
  | "home"
  | "notifications"
  | "likes"
  | "followers"
  | "following"
  | "media"
  | "login"
  | "logout"
  | "refresh"
  | "strategy";

export interface StatusInput {
  json?: boolean;
}

export interface PostInput {
  text: string;
}

export interface ReplyInput {
  tweetUrl: string;
  text: string;
}

export interface TimelineInput {
  screenName: string;
  count?: number;
}

export interface TweetInput {
  tweetIdOrUrl: string;
}

export interface SearchInput {
  query: string;
  count?: number;
  product?: "Top" | "Latest" | "People" | "Media";
}

export interface BookmarksInput {
  count?: number;
}

export interface HomeInput {
  count?: number;
}

export interface NotificationsInput {
  count?: number;
}

export interface LikesInput {
  screenName: string;
  count?: number;
}

export interface FollowersInput {
  screenName: string;
  count?: number;
}

export interface FollowingInput {
  screenName: string;
  count?: number;
}

export interface MediaInput {
  screenName: string;
  count?: number;
}

export interface StrategyInput {
  action?: "get" | "set";
  value?: "oauth" | "browser" | "auto";
}

// ---------------------------------------------------------------------------
// Result Types
// ---------------------------------------------------------------------------

export interface PostResult {
  ok: boolean;
  tweetId?: string;
  text?: string;
  url?: string;
  pathUsed?: "oauth" | "browser";
  error?: string;
}

export interface TimelineResult {
  ok: boolean;
  user?: TwitterUser;
  tweets?: Tweet[];
  error?: string;
}

export interface TweetResult {
  ok: boolean;
  tweet?: Tweet;
  replies?: Tweet[];
  error?: string;
}

export interface SearchResult {
  ok: boolean;
  tweets?: Tweet[];
  error?: string;
}

export interface NotificationsResult {
  ok: boolean;
  notifications?: Notification[];
  error?: string;
}

export interface FollowersResult {
  ok: boolean;
  user?: TwitterUser;
  followers?: TwitterUser[];
  error?: string;
}

export interface FollowingResult {
  ok: boolean;
  user?: TwitterUser;
  following?: TwitterUser[];
  error?: string;
}

export interface StrategyResult {
  ok: boolean;
  strategy?: "oauth" | "browser" | "auto";
  error?: string;
}

// ---------------------------------------------------------------------------
// Placeholder Implementations (to be filled in M2)
// ---------------------------------------------------------------------------

export async function executeTwitterCommand(
  command: TwitterCommand,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  // TODO: Implement in M2 - will delegate to the assistant's Twitter client
  return {
    content: JSON.stringify({
      ok: false,
      error: `Command "${command}" not yet implemented`,
    }),
    isError: true,
  };
}
