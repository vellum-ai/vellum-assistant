import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

// -- Tool contract --

interface ToolContext {
  workingDir: string;
  sessionId: string;
  conversationId: string;
  [key: string]: unknown;
}

interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

// -- Inline DB schema (only the tables we touch) --

const memoryItems = sqliteTable('memory_items', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  subject: text('subject').notNull(),
  statement: text('statement').notNull(),
  status: text('status').notNull(),
  confidence: real('confidence').notNull(),
  importance: real('importance'),
  accessCount: integer('access_count').notNull().default(0),
  fingerprint: text('fingerprint').notNull(),
  verificationState: text('verification_state').notNull().default('assistant_inferred'),
  scopeId: text('scope_id').notNull().default('default'),
  firstSeenAt: integer('first_seen_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
  lastUsedAt: integer('last_used_at'),
  validFrom: integer('valid_from'),
  invalidAt: integer('invalid_at'),
}, (table) => [
  index('idx_memory_items_scope_id').on(table.scopeId),
  index('idx_memory_items_fingerprint').on(table.fingerprint),
]);

const schema = { memoryItems };

function getDbPath(): string {
  const baseDir = process.env.BASE_DATA_DIR?.trim() || homedir();
  return join(baseDir, '.vellum', 'workspace', 'data', 'db', 'assistant.db');
}

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function getDb() {
  if (!_db) {
    const dbPath = getDbPath();
    mkdirSync(join(dbPath, '..'), { recursive: true });
    const sqlite = new Database(dbPath);
    sqlite.exec('PRAGMA journal_mode=WAL');
    sqlite.exec('PRAGMA foreign_keys = ON');
    _db = drizzle(sqlite, { schema });
  }
  return _db;
}

// -- Memory fingerprint (must match assistant's computeMemoryFingerprint) --

function computeFingerprint(scopeId: string, kind: string, subject: string, statement: string): string {
  const normalized = `${scopeId}|${kind}|${subject.toLowerCase()}|${statement.toLowerCase()}`;
  return createHash('sha256').update(normalized).digest('hex');
}

// -- Reddit API types --

interface RedditAbout {
  data: {
    name: string;
    created_utc: number;
    link_karma: number;
    comment_karma: number;
    icon_img?: string;
    subreddit?: { display_name_prefixed?: string };
  };
}

interface RedditListing {
  data: {
    children: Array<{
      kind: 't1' | 't3';
      data: RedditPost | RedditComment;
    }>;
    after: string | null;
  };
}

interface RedditPost {
  id: string;
  title: string;
  selftext: string;
  subreddit: string;
  score: number;
  created_utc: number;
  url: string;
  is_self: boolean;
}

interface RedditComment {
  id: string;
  body: string;
  subreddit: string;
  score: number;
  created_utc: number;
  link_title?: string;
}

// -- Extracted memory item shape --

interface ExtractedMemoryItem {
  kind: 'preference' | 'profile' | 'fact' | 'opinion' | 'style' | 'interest';
  subject: string;
  statement: string;
  confidence: number;
  importance: number;
}

// -- Reddit fetch helpers --

const REDDIT_HEADERS = {
  'User-Agent': 'VellumAssistant/1.0 (reddit-profile-skill; contact: admin@vellum.ai)',
  'Accept': 'application/json',
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: REDDIT_HEADERS });
  if (!res.ok) {
    throw new Error(`Reddit API error: ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json() as Promise<T>;
}

async function fetchUserAbout(username: string): Promise<RedditAbout['data']> {
  const data = await fetchJson<RedditAbout>(`https://www.reddit.com/user/${encodeURIComponent(username)}/about.json`);
  return data.data;
}

async function fetchUserContent(username: string, type: 'submitted' | 'comments', limit: number): Promise<RedditListing['data']['children']> {
  const url = `https://www.reddit.com/user/${encodeURIComponent(username)}/${type}.json?limit=${limit}&raw_json=1`;
  const data = await fetchJson<RedditListing>(url);
  return data.data.children;
}

// -- Personality analysis via Claude API --

interface AnalysisResult {
  items: ExtractedMemoryItem[];
}

async function analyzeWithClaude(username: string, about: RedditAbout['data'], sampleText: string): Promise<ExtractedMemoryItem[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Fall back to pattern-based extraction if no API key
    return extractPatternBased(username, about, sampleText);
  }

  const systemPrompt = `You are a personality analysis system. Given a Reddit user's profile and a sample of their posts and comments, extract structured memory items that capture who this person is.

Extract items in these categories:
- profile: Personal facts (username, account age, activity level, main communities)
- interest: Topics, hobbies, or subject areas the user engages with
- preference: Likes, dislikes, preferred tools, platforms, or approaches
- opinion: Viewpoints or stances on topics they discuss
- style: Communication style, tone, vocabulary, humor, writing habits
- fact: Notable facts about the user derived from their activity

For each item:
- kind: One of the categories above
- subject: A short label (2-8 words) for what this is about
- statement: A factual statement to remember about this person (1-2 sentences). Write it in third person about "the user".
- confidence: Confidence that this is accurate (0.0–1.0). Higher for explicit statements, lower for inferences.
- importance: How useful this is for personalizing conversations (0.0–1.0).
  - 0.9: Core identity facts, strong recurring themes
  - 0.7: Clear interests and preferences with multiple data points
  - 0.5: Inferred from limited evidence
  - 0.3: Weak signals, might not be consistent

Return a JSON object: { "items": [...] }`;

  const userPrompt = `Reddit username: ${username}
Account created: ${new Date(about.created_utc * 1000).toISOString().split('T')[0]}
Link karma: ${about.link_karma}
Comment karma: ${about.comment_karma}

Sample of posts and comments:
${sampleText}

Extract memory items about this Reddit user's personality, interests, preferences, and communication style.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [{
        name: 'store_personality_items',
        description: 'Store extracted personality and interest items about the Reddit user',
        input_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['preference', 'profile', 'fact', 'opinion', 'style', 'interest'] },
                  subject: { type: 'string' },
                  statement: { type: 'string' },
                  confidence: { type: 'number' },
                  importance: { type: 'number' },
                },
                required: ['kind', 'subject', 'statement', 'confidence', 'importance'],
              },
            },
          },
          required: ['items'],
        },
      }],
      tool_choice: { type: 'tool', name: 'store_personality_items' },
    }),
  });

  if (!response.ok) {
    // Gracefully fall back to pattern-based if Claude call fails
    return extractPatternBased(username, about, sampleText);
  }

  const result = await response.json() as {
    content: Array<{ type: string; input?: AnalysisResult }>;
  };

  const toolUse = result.content.find((c) => c.type === 'tool_use');
  if (!toolUse?.input?.items) {
    return extractPatternBased(username, about, sampleText);
  }

  return toolUse.input.items.map((item) => ({
    ...item,
    confidence: Math.min(1, Math.max(0, item.confidence)),
    importance: Math.min(1, Math.max(0, item.importance)),
  }));
}

// -- Pattern-based fallback extraction --

function extractPatternBased(username: string, about: RedditAbout['data'], sampleText: string): ExtractedMemoryItem[] {
  const items: ExtractedMemoryItem[] = [];

  // Always add the username as a profile item
  const accountAgeYears = ((Date.now() / 1000 - about.created_utc) / (365.25 * 24 * 3600)).toFixed(1);
  items.push({
    kind: 'profile',
    subject: 'Reddit username',
    statement: `The user's Reddit username is u/${username}, with an account ${accountAgeYears} years old and ${about.link_karma + about.comment_karma} total karma.`,
    confidence: 1.0,
    importance: 0.7,
  });

  // Extract subreddits from sample text
  const subredditMatches = sampleText.match(/r\/[\w]+/g) ?? [];
  const subredditCounts = new Map<string, number>();
  for (const sub of subredditMatches) {
    subredditCounts.set(sub, (subredditCounts.get(sub) ?? 0) + 1);
  }
  const topSubreddits = [...subredditCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([sub]) => sub);

  if (topSubreddits.length > 0) {
    items.push({
      kind: 'interest',
      subject: 'Reddit communities',
      statement: `The user is most active in: ${topSubreddits.join(', ')}.`,
      confidence: 0.8,
      importance: 0.7,
    });
  }

  return items;
}

// -- Memory upsert --

function upsertMemoryItems(items: ExtractedMemoryItem[], scopeId: string): { inserted: number; updated: number } {
  const db = getDb();
  const now = Date.now();
  let inserted = 0;
  let updated = 0;

  for (const item of items) {
    // Map 'interest' to 'fact' since it's not a built-in kind in the schema allowlist
    const kind = item.kind === 'interest' ? 'fact' : item.kind;
    const fingerprint = computeFingerprint(scopeId, kind, item.subject, item.statement);

    const existing = db
      .select()
      .from(memoryItems)
      .where(and(
        eq(memoryItems.fingerprint, fingerprint),
        eq(memoryItems.scopeId, scopeId),
      ))
      .get();

    if (existing) {
      db.update(memoryItems)
        .set({
          status: 'active',
          confidence: Math.min(1, Math.max(existing.confidence, item.confidence)),
          importance: Math.min(1, Math.max(existing.importance ?? 0, item.importance)),
          lastSeenAt: now,
          verificationState: 'user_reported',
        })
        .where(eq(memoryItems.id, existing.id))
        .run();
      updated++;
    } else {
      db.insert(memoryItems).values({
        id: uuid(),
        kind,
        subject: item.subject,
        statement: item.statement,
        status: 'active',
        confidence: item.confidence,
        importance: item.importance,
        fingerprint,
        verificationState: 'user_reported',
        scopeId,
        firstSeenAt: now,
        lastSeenAt: now,
        lastUsedAt: null,
        validFrom: null,
        invalidAt: null,
      }).run();
      inserted++;
    }
  }

  return { inserted, updated };
}

// -- Sample text builder --

function buildSampleText(
  posts: Array<{ data: RedditPost }>,
  comments: Array<{ data: RedditComment }>,
  maxChars = 12000,
): string {
  const lines: string[] = [];

  for (const { data: post } of posts) {
    if (post.selftext && post.selftext !== '[deleted]' && post.selftext !== '[removed]') {
      lines.push(`[Post in r/${post.subreddit}] ${post.title}: ${post.selftext.slice(0, 500)}`);
    } else if (post.title) {
      lines.push(`[Post in r/${post.subreddit}] ${post.title}`);
    }
    if (lines.join('\n').length > maxChars / 2) break;
  }

  for (const { data: comment } of comments) {
    if (comment.body && comment.body !== '[deleted]' && comment.body !== '[removed]') {
      lines.push(`[Comment in r/${comment.subreddit}] ${comment.body.slice(0, 300)}`);
    }
    if (lines.join('\n').length > maxChars) break;
  }

  return lines.join('\n\n');
}

// -- Tool entry point --

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const username = (input.username as string | undefined)?.trim().replace(/^u\//, '');
  if (!username) {
    return { content: 'Error: username is required', isError: true };
  }

  const limit = Math.min(100, Math.max(1, Number(input.limit ?? 100)));

  // Fetch public profile data
  let about: RedditAbout['data'];
  try {
    about = await fetchUserAbout(username);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('404')) {
      return { content: `Error: Reddit user u/${username} not found. Please check the username and try again.`, isError: true };
    }
    return { content: `Error fetching Reddit profile: ${msg}`, isError: true };
  }

  // Fetch posts and comments in parallel
  let posts: Array<{ kind: string; data: RedditPost }> = [];
  let comments: Array<{ kind: string; data: RedditComment }> = [];

  try {
    const [postsRaw, commentsRaw] = await Promise.all([
      fetchUserContent(username, 'submitted', limit),
      fetchUserContent(username, 'comments', limit),
    ]);
    posts = postsRaw as Array<{ kind: string; data: RedditPost }>;
    comments = commentsRaw as Array<{ kind: string; data: RedditComment }>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Partial failure is ok — we can still analyze with what we have
    if (posts.length === 0 && comments.length === 0) {
      return { content: `Error fetching Reddit content for u/${username}: ${msg}`, isError: true };
    }
  }

  if (posts.length === 0 && comments.length === 0) {
    return {
      content: `No public posts or comments found for u/${username}. The account may be private, shadowbanned, or have no activity.`,
      isError: false,
    };
  }

  // Build sample text for analysis
  const sampleText = buildSampleText(
    posts as Array<{ data: RedditPost }>,
    comments as Array<{ data: RedditComment }>,
  );

  // Always include a baseline profile item for the username regardless of LLM result
  const baselineItem: ExtractedMemoryItem = {
    kind: 'profile',
    subject: 'Reddit username',
    statement: `The user's Reddit username is u/${username}. Their account was created on ${new Date(about.created_utc * 1000).toISOString().split('T')[0]} and has ${about.link_karma} link karma and ${about.comment_karma} comment karma.`,
    confidence: 1.0,
    importance: 0.75,
  };

  // Analyze with Claude (falls back to pattern-based automatically)
  let extracted: ExtractedMemoryItem[] = [];
  try {
    extracted = await analyzeWithClaude(username, about, sampleText);
  } catch (err) {
    extracted = extractPatternBased(username, about, sampleText);
  }

  // Ensure baseline is included (dedup by subject)
  const hasUsernameItem = extracted.some(
    (i) => i.kind === 'profile' && i.subject.toLowerCase().includes('reddit'),
  );
  if (!hasUsernameItem) {
    extracted = [baselineItem, ...extracted];
  }

  // Write to memory
  const scopeId = 'default';
  const { inserted, updated } = upsertMemoryItems(extracted, scopeId);

  // Build summary
  const topSubreddits = getTopSubreddits(posts as Array<{ data: RedditPost }>, comments as Array<{ data: RedditComment }>);
  const subredditSummary = topSubreddits.length > 0
    ? `\nTop communities: ${topSubreddits.slice(0, 5).join(', ')}`
    : '';

  const summary = [
    `Ingested Reddit profile for u/${username}:`,
    `- ${posts.length} post(s) and ${comments.length} comment(s) analyzed`,
    `- ${inserted} new memory item(s) created, ${updated} updated`,
    subredditSummary,
  ].filter(Boolean).join('\n');

  return { content: summary, isError: false };
}

function getTopSubreddits(
  posts: Array<{ data: RedditPost }>,
  comments: Array<{ data: RedditComment }>,
): string[] {
  const counts = new Map<string, number>();
  for (const { data } of posts) {
    if (data.subreddit) counts.set(`r/${data.subreddit}`, (counts.get(`r/${data.subreddit}`) ?? 0) + 1);
  }
  for (const { data } of comments) {
    if (data.subreddit) counts.set(`r/${data.subreddit}`, (counts.get(`r/${data.subreddit}`) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([sub]) => sub);
}
