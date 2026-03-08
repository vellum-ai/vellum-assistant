/**
 * Influencer Research Client
 *
 * ARCHITECTURE
 * ============
 * All scraping runs inside Chrome browser tabs via the extension relay. The
 * relay's evaluate command uses CDP Runtime.evaluate (via chrome.debugger API)
 * as a fallback, which bypasses strict CSP on sites like Instagram.
 *
 * The user must be logged into Instagram, TikTok, and/or X in their Chrome
 * browser for this to work.
 *
 * INSTAGRAM DISCOVERY FLOW
 * ========================
 * Instagram's search at /explore/search/keyword/?q=... returns a grid of POSTS
 * (not profiles). To discover influencers:
 *   1. Search by keyword → get grid of post links (/p/ and /reel/)
 *   2. Visit each post → extract the author username from page text
 *   3. Deduplicate usernames
 *   4. Visit each unique profile → scrape stats from meta[name="description"]
 *      which reliably contains "49K Followers, 463 Following, 551 Posts - ..."
 *   5. Filter by criteria and rank
 *
 * TIKTOK DISCOVERY FLOW
 * =====================
 * TikTok has a dedicated user search at /search/user?q=... which returns
 * profile cards directly with follower counts and bios.
 *
 * X/TWITTER DISCOVERY FLOW
 * ========================
 * X has a people search at /search?q=...&f=user which returns UserCell
 * components with profile data.
 *
 * EVALUATE SCRIPTS
 * ================
 * All scripts passed to evalInTab() are wrapped in (function(){ ... })() by
 * the relay's CDP Runtime.evaluate. Use `return` to return values. Results
 * should be JSON strings for complex data.
 *
 * LIMITATIONS
 * ===========
 *   - Requires the user to be logged in on each platform in Chrome
 *   - Rate limiting may apply; built-in delays of 1.5-3s between navigations
 *   - Platform HTML structures change frequently; selectors may need updates
 *   - The chrome.debugger API shows a yellow infobar on the tab being debugged
 */

import type {
  ExtensionCommand,
  ExtensionResponse,
} from "../../../browser-extension-relay/protocol.js";
import { extensionRelayServer } from "../../../browser-extension-relay/server.js";
import {
  initAuthSigningKey,
  isSigningKeyInitialized,
  loadOrCreateSigningKey,
} from "../../../runtime/auth/token-service.js";
import { gatewayPost } from "../../../runtime/gateway-internal-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InfluencerSearchCriteria {
  /** Keywords, niche, or topic to search for */
  query: string;
  /** Platforms to search on */
  platforms?: ("instagram" | "tiktok" | "twitter")[];
  /** Minimum follower count */
  minFollowers?: number;
  /** Maximum follower count */
  maxFollowers?: number;
  /** Maximum number of results per platform */
  limit?: number;
  /** Language/locale filter */
  language?: string;
  /** Look for verified accounts only */
  verifiedOnly?: boolean;
}

export interface InfluencerProfile {
  /** Platform the profile was found on */
  platform: "instagram" | "tiktok" | "twitter";
  /** Username/handle */
  username: string;
  /** Display name */
  displayName: string;
  /** Profile URL */
  profileUrl: string;
  /** Bio/description */
  bio: string;
  /** Follower count (numeric) */
  followers: number | undefined;
  /** Follower count (display string, e.g. "1.2M") */
  followersDisplay: string;
  /** Following count */
  following: number | undefined;
  /** Post/video count */
  postCount: number | undefined;
  /** Whether the account is verified */
  isVerified: boolean;
  /** Profile picture URL */
  avatarUrl: string | undefined;
  /** Engagement rate estimate (if available) */
  engagementRate: number | undefined;
  /** Average likes per post (if available from recent posts) */
  avgLikes: number | undefined;
  /** Average comments per post (if available from recent posts) */
  avgComments: number | undefined;
  /** Content categories/themes detected from bio and recent posts */
  contentThemes: string[];
  /** Recent post captions/snippets for context */
  recentPosts: { text: string; likes?: number; comments?: number }[];
  /** Raw score for ranking */
  relevanceScore: number;
}

export interface InfluencerSearchResult {
  platform: string;
  profiles: InfluencerProfile[];
  count: number;
  query: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Relay command routing (same pattern as Amazon client)
// ---------------------------------------------------------------------------

async function sendRelayCommand(
  command: Record<string, unknown>,
): Promise<ExtensionResponse> {
  const status = extensionRelayServer.getStatus();
  if (status.connected) {
    return extensionRelayServer.sendCommand(
      command as Omit<ExtensionCommand, "id">,
    );
  }

  // Fall back to HTTP relay endpoint via the gateway.
  // The gateway validates edge JWTs (aud=vellum-gateway) and mints an
  // exchange token for the runtime. In CLI out-of-process contexts the
  // signing key may not be initialized yet — load it from disk.
  if (!isSigningKeyInitialized()) {
    initAuthSigningKey(loadOrCreateSigningKey());
  }

  const { data } = await gatewayPost<ExtensionResponse>(
    "/v1/browser-relay/command",
    command,
  );
  return data;
}

// ---------------------------------------------------------------------------
// Tab management & eval
// ---------------------------------------------------------------------------

async function findOrOpenTab(
  urlPattern: string,
  fallbackUrl: string,
): Promise<number> {
  const resp = await sendRelayCommand({ action: "find_tab", url: urlPattern });
  if (resp.success && resp.tabId !== undefined) {
    return resp.tabId;
  }

  const newTab = await sendRelayCommand({
    action: "new_tab",
    url: fallbackUrl,
  });
  if (!newTab.success || newTab.tabId === undefined) {
    throw new Error(`Could not open tab for ${fallbackUrl}`);
  }

  await sleep(2500);
  return newTab.tabId;
}

async function navigateTab(tabId: number, url: string): Promise<void> {
  const resp = await sendRelayCommand({ action: "navigate", tabId, url });
  if (!resp.success) {
    throw new Error(`Failed to navigate: ${resp.error ?? "unknown error"}`);
  }
  await sleep(3000);
}

/**
 * Evaluate a JS script in a tab. The script is wrapped in an IIFE by the relay
 * so use `return` to yield a value. For complex results, return a JSON string.
 */
async function evalInTab(tabId: number, script: string): Promise<unknown> {
  const resp = await sendRelayCommand({
    action: "evaluate",
    tabId,
    code: script,
  });
  if (!resp.success) {
    throw new Error(`Browser eval failed: ${resp.error ?? "unknown error"}`);
  }
  return resp.result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Follower count parser
// ---------------------------------------------------------------------------

function parseFollowerCount(text: string): number | undefined {
  if (!text) return undefined;
  const cleaned = text
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/\s+/g, "")
    .trim();
  const match = cleaned.match(/([\d.]+)\s*([kmbt]?)/);
  if (!match) return undefined;

  const num = parseFloat(match[1]);
  const suffix = match[2];
  const multipliers: Record<string, number> = {
    "": 1,
    k: 1_000,
    m: 1_000_000,
    b: 1_000_000_000,
    t: 1_000_000_000_000,
  };
  return Math.round(num * (multipliers[suffix] || 1));
}

// ---------------------------------------------------------------------------
// Instagram scraping
// ---------------------------------------------------------------------------

/**
 * Search Instagram for influencers by keyword.
 *
 * Strategy: search by keyword → extract post links → visit each post to find
 * the author → deduplicate → visit each unique profile for stats.
 */
async function searchInstagram(
  criteria: InfluencerSearchCriteria,
): Promise<InfluencerProfile[]> {
  const limit = criteria.limit ?? 10;
  const tabId = await findOrOpenTab(
    "*://*.instagram.com/*",
    "https://www.instagram.com",
  );

  // Step 1: Navigate to keyword search (shows a grid of posts)
  const searchUrl = `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(
    criteria.query,
  )}`;
  await navigateTab(tabId, searchUrl);
  await sleep(2000);

  // Step 2: Extract post links from the search grid
  const postLinksRaw = await evalInTab(
    tabId,
    `
    var links = [];
    document.querySelectorAll('a[href]').forEach(function(a) {
      var h = a.getAttribute('href');
      if (h && (h.indexOf('/p/') > -1 || h.indexOf('/reel/') > -1)) links.push(h);
    });
    return JSON.stringify(links.slice(0, ${limit * 2}));
  `,
  );

  let postLinks: string[];
  try {
    postLinks = JSON.parse(String(postLinksRaw));
  } catch {
    postLinks = [];
  }

  if (postLinks.length === 0) {
    return [];
  }

  // Step 3: Visit each post to extract the author username
  const seenUsernames = new Set<string>();
  const authorUsernames: string[] = [];

  // Navigation skip list — known non-profile IG paths
  const skipUsernames = new Set([
    "reels",
    "explore",
    "stories",
    "direct",
    "accounts",
    "about",
    "p",
    "reel",
    "tv",
    "search",
    "nametag",
    "directory",
    "",
  ]);

  for (const postLink of postLinks) {
    if (authorUsernames.length >= limit) break;

    try {
      await navigateTab(tabId, `https://www.instagram.com${postLink}`);
      await sleep(1000);

      // Extract the author username from the post page.
      // The post page body text starts with navigation items, then shows:
      //   "username\n...audio info...\nFollow\nusername\n..."
      // We look for the first profile link that isn't a nav item.
      const authorRaw = await evalInTab(
        tabId,
        `
        var bodyText = document.body.innerText;
        // The author name appears after navigation elements, usually right before "Follow"
        // Also try extracting from links
        var links = document.querySelectorAll('a[href]');
        var skip = ['', 'reels', 'explore', 'stories', 'direct', 'accounts', 'about',
                     'p', 'reel', 'tv', 'search', 'nametag', 'directory'];
        var navLabels = ['Instagram', 'Home', 'HomeHome', 'Reels', 'ReelsReels', 'Messages',
                         'MessagesMessages', 'Search', 'SearchSearch', 'Explore', 'ExploreExplore',
                         'Notifications', 'NotificationsNotifications', 'Create', 'New postCreate',
                         'Profile', 'More', 'SettingsMore', 'Also from Meta', 'Also from MetaAlso from Meta'];
        var author = null;
        for (var i = 0; i < links.length; i++) {
          var href = links[i].getAttribute('href') || '';
          var text = links[i].textContent.trim();
          var match = href.match(/^\\/([a-zA-Z0-9_.]+)\\/$/);
          if (!match) continue;
          var username = match[1];
          if (skip.indexOf(username) > -1) continue;
          if (navLabels.indexOf(text) > -1) continue;
          // Skip the logged-in user's profile link (usually "Profile" or their own name in nav)
          if (text === 'Profile' || text === '') continue;
          author = username;
          break;
        }
        // Fallback: parse from body text — look for the pattern after "Follow\\n"
        if (!author) {
          var followIdx = bodyText.indexOf('Follow\\n');
          if (followIdx > -1) {
            var afterFollow = bodyText.substring(followIdx + 7, followIdx + 50);
            var lineEnd = afterFollow.indexOf('\\n');
            if (lineEnd > -1) {
              author = afterFollow.substring(0, lineEnd).trim();
            }
          }
        }
        return author;
      `,
      );

      const authorUsername = String(authorRaw || "").trim();
      if (
        authorUsername &&
        !skipUsernames.has(authorUsername) &&
        !seenUsernames.has(authorUsername)
      ) {
        seenUsernames.add(authorUsername);
        authorUsernames.push(authorUsername);
      }
    } catch {
      // Skip posts that fail
      continue;
    }
  }

  if (authorUsernames.length === 0) {
    return [];
  }

  // Step 4: Visit each unique profile to scrape stats
  const profiles: InfluencerProfile[] = [];

  for (const username of authorUsernames) {
    try {
      const profile = await scrapeInstagramProfile(tabId, username, criteria);
      if (profile && matchesCriteria(profile, criteria)) {
        profiles.push(profile);
      }
      await sleep(1500);
    } catch {
      continue;
    }
  }

  return profiles;
}

/**
 * Scrape a single Instagram profile page for stats.
 *
 * The most reliable data source is the meta[name="description"] tag which
 * contains: "49K Followers, 463 Following, 551 Posts - Display Name (@username)
 * on Instagram: "bio text""
 *
 * Falls back to parsing from body text.
 */
async function scrapeInstagramProfile(
  tabId: number,
  username: string,
  criteria: InfluencerSearchCriteria,
): Promise<InfluencerProfile | null> {
  await navigateTab(tabId, `https://www.instagram.com/${username}/`);
  await sleep(2000);

  const raw = await evalInTab(
    tabId,
    `
    var r = { username: '${username}' };

    // Primary source: meta description tag
    // Format: "49K Followers, 463 Following, 551 Posts - Display Name (@user) on Instagram: \\"bio\\""
    var meta = document.querySelector('meta[name="description"]');
    r.meta = meta ? meta.getAttribute('content') : '';

    // Parse meta for structured data
    if (r.meta) {
      var fMatch = r.meta.match(/([\\d,.]+[KkMmBb]?)\\s*Follower/i);
      var fgMatch = r.meta.match(/([\\d,.]+[KkMmBb]?)\\s*Following/i);
      var pMatch = r.meta.match(/([\\d,.]+[KkMmBb]?)\\s*Post/i);
      r.followers = fMatch ? fMatch[1] : '';
      r.following = fgMatch ? fgMatch[1] : '';
      r.posts = pMatch ? pMatch[1] : '';

      // Display name: between "Posts - " and " (@"
      var nameMatch = r.meta.match(/Posts\\s*-\\s*(.+?)\\s*\\(@/);
      r.displayName = nameMatch ? nameMatch[1].trim() : '';

      // Bio: after 'on Instagram: "' until end quote
      var bioMatch = r.meta.match(/on Instagram:\\s*"(.+?)"/);
      r.bio = bioMatch ? bioMatch[1] : '';
    }

    // Fallback: parse from body text
    var bodyText = document.body.innerText;
    if (!r.followers) {
      var bfMatch = bodyText.match(/([\\d,.]+[KkMmBb]?)\\s*followers/i);
      r.followers = bfMatch ? bfMatch[1] : '';
    }
    if (!r.following) {
      var bgMatch = bodyText.match(/([\\d,.]+[KkMmBb]?)\\s*following/i);
      r.following = bgMatch ? bgMatch[1] : '';
    }
    if (!r.posts) {
      var bpMatch = bodyText.match(/([\\d,.]+[KkMmBb]?)\\s*posts/i);
      r.posts = bpMatch ? bpMatch[1] : '';
    }

    // Verified status
    r.isVerified = bodyText.indexOf('Verified') > -1;

    // Bio fallback: grab the text between "following" and "Follow" button
    if (!r.bio) {
      var followingIdx = bodyText.indexOf(' following');
      if (followingIdx > -1) {
        var afterFollowing = bodyText.substring(followingIdx + 10, followingIdx + 400);
        // Cut at common boundaries
        var cutPoints = ['Follow', 'Message', 'Meta', 'About'];
        var minCut = afterFollowing.length;
        for (var c = 0; c < cutPoints.length; c++) {
          var idx = afterFollowing.indexOf(cutPoints[c]);
          if (idx > -1 && idx < minCut) minCut = idx;
        }
        r.bio = afterFollowing.substring(0, minCut).trim();
      }
    }

    // Avatar
    var avatarEl = document.querySelector('header img') ||
                   document.querySelector('img[alt*="profile"]');
    r.avatarUrl = avatarEl ? avatarEl.getAttribute('src') : null;

    return JSON.stringify(r);
  `,
  );

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(String(raw));
  } catch {
    return null;
  }

  const followersNum = parseFollowerCount(String(data.followers || ""));
  const followingNum = parseFollowerCount(String(data.following || ""));
  const postCount = parseFollowerCount(String(data.posts || ""));

  return {
    platform: "instagram",
    username,
    displayName: String(data.displayName || username),
    profileUrl: `https://www.instagram.com/${username}/`,
    bio: String(data.bio || ""),
    followers: followersNum,
    followersDisplay: String(data.followers || "unknown"),
    following: followingNum,
    postCount,
    isVerified: Boolean(data.isVerified),
    avatarUrl: data.avatarUrl ? String(data.avatarUrl) : undefined,
    engagementRate: undefined,
    avgLikes: undefined,
    avgComments: undefined,
    contentThemes: extractThemes(
      String(data.bio || "") + " " + String(data.meta || ""),
      criteria.query,
    ),
    recentPosts: [],
    relevanceScore: 0,
  };
}

// ---------------------------------------------------------------------------
// TikTok scraping
// ---------------------------------------------------------------------------

/**
 * Search TikTok for influencers by keyword.
 *
 * TikTok's user search at /search/user?q=... renders a list where each card
 * produces a predictable text pattern in innerText:
 *
 *   DisplayName
 *   username
 *   77.9K          (follower count)
 *   Followers
 *   ·
 *   1.5M           (like count)
 *   Likes
 *   Follow
 *
 * DOM class-based selectors are unreliable on TikTok (obfuscated class names),
 * so we parse this text pattern directly.
 */
async function searchTikTok(
  criteria: InfluencerSearchCriteria,
): Promise<InfluencerProfile[]> {
  const limit = criteria.limit ?? 10;
  const tabId = await findOrOpenTab(
    "*://*.tiktok.com/*",
    "https://www.tiktok.com",
  );

  const searchUrl = `https://www.tiktok.com/search/user?q=${encodeURIComponent(
    criteria.query,
  )}`;
  await navigateTab(tabId, searchUrl);
  await sleep(3000);

  // Scroll to load more results
  await evalInTab(
    tabId,
    `window.scrollTo(0, document.body.scrollHeight); return 'scrolled'`,
  );
  await sleep(2000);

  // Parse the text pattern: DisplayName, username, count, "Followers", "·", count, "Likes"
  const raw = await evalInTab(
    tabId,
    `
    var text = document.body.innerText;
    var lines = text.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
    var users = [];
    for (var i = 0; i < lines.length - 6; i++) {
      if (lines[i+2] &&
          lines[i+2].match(/^[\\d,.]+[KkMmBb]?$/) &&
          lines[i+3] === 'Followers' &&
          lines[i+4] === '·' &&
          lines[i+6] === 'Likes') {
        var username = lines[i+1];
        if (!username.match(/^[a-zA-Z0-9_.]+$/)) continue;
        users.push({
          displayName: lines[i],
          username: username,
          followers: lines[i+2],
          likes: lines[i+5],
        });
        i += 7;
      }
    }
    return JSON.stringify(users.slice(0, ${limit * 2}));
  `,
  );

  let searchResults: Array<{
    username: string;
    displayName: string;
    followers: string;
    likes: string;
  }>;
  try {
    searchResults = JSON.parse(String(raw));
  } catch {
    return [];
  }

  // Convert to profiles — we only have basic data from search, no bios yet
  const profiles: InfluencerProfile[] = searchResults.map((p) => ({
    platform: "tiktok" as const,
    username: p.username,
    displayName: p.displayName || p.username,
    profileUrl: `https://www.tiktok.com/@${p.username}`,
    bio: "",
    followers: parseFollowerCount(p.followers),
    followersDisplay: p.followers || "unknown",
    following: undefined,
    postCount: undefined,
    isVerified: false,
    avatarUrl: undefined,
    engagementRate: undefined,
    avgLikes: undefined,
    avgComments: undefined,
    contentThemes: extractThemes(p.displayName, criteria.query),
    recentPosts: [],
    relevanceScore: 0,
  }));

  // Filter by criteria first to avoid unnecessary profile visits
  const filtered = profiles.filter((p) => matchesCriteria(p, criteria));

  // Enrich with bios by visiting each profile
  const enriched: InfluencerProfile[] = [];
  for (const profile of filtered.slice(0, limit)) {
    try {
      const detailed = await scrapeTikTokProfile(
        tabId,
        profile.username,
        criteria,
      );
      if (detailed) {
        enriched.push(detailed);
      } else {
        enriched.push(profile);
      }
      await sleep(1500);
    } catch {
      enriched.push(profile);
    }
  }

  return enriched;
}

/**
 * Scrape a single TikTok profile page for detailed stats.
 *
 * TikTok profile pages show stats and bio in the body text. We use a
 * combination of data-e2e selectors (when they work) and body text regex
 * as a fallback. The bio is also extracted from the region between
 * "Following" and "Videos" in the body text.
 */
async function scrapeTikTokProfile(
  tabId: number,
  username: string,
  criteria: InfluencerSearchCriteria,
): Promise<InfluencerProfile | null> {
  await navigateTab(tabId, `https://www.tiktok.com/@${username}`);
  await sleep(2500);

  const raw = await evalInTab(
    tabId,
    `
    var r = { username: '${username}' };
    var bodyText = document.body.innerText;

    // Stats from body text (most reliable)
    var fMatch = bodyText.match(/([\\d,.]+[KkMmBb]?)\\s*[Ff]ollower/);
    var fgMatch = bodyText.match(/([\\d,.]+[KkMmBb]?)\\s*[Ff]ollowing/);
    var lMatch = bodyText.match(/([\\d,.]+[KkMmBb]?)\\s*[Ll]ike/);
    r.followers = fMatch ? fMatch[1] : '';
    r.following = fgMatch ? fgMatch[1] : '';
    r.likes = lMatch ? lMatch[1] : '';

    // Bio: try data-e2e selector first, fall back to text parsing
    var bioEl = document.querySelector('[data-e2e="user-bio"]') ||
                document.querySelector('h2[data-e2e="user-subtitle"]');
    r.bio = bioEl ? bioEl.textContent.trim() : '';

    if (!r.bio) {
      // Fallback: extract bio from between "Following" and "Videos" in body text
      var followingIdx = bodyText.indexOf('Following');
      if (followingIdx > -1) {
        var chunk = bodyText.substring(followingIdx + 10, followingIdx + 500);
        var videosIdx = chunk.indexOf('Videos');
        if (videosIdx > -1) chunk = chunk.substring(0, videosIdx);
        // Also cut at "Liked" or "Reposts"
        var likedIdx = chunk.indexOf('Liked');
        if (likedIdx > -1 && likedIdx < chunk.length) chunk = chunk.substring(0, likedIdx);
        r.bio = chunk.trim();
      }
    }

    // Display name: try data-e2e, fall back to page title
    var nameEl = document.querySelector('[data-e2e="user-title"]') ||
                 document.querySelector('h1[data-e2e="user-title"]');
    r.displayName = nameEl ? nameEl.textContent.trim() : '';
    if (!r.displayName) {
      // TikTok titles are often "displayname (@username) | TikTok"
      var titleMatch = document.title.match(/^(.+?)\\s*\\(@/);
      r.displayName = titleMatch ? titleMatch[1].trim() : '${username}';
    }

    // Verified
    r.isVerified = bodyText.indexOf('Verified') > -1 ||
                   !!document.querySelector('svg[class*="verify"]') ||
                   !!document.querySelector('[class*="verified"]');

    // Avatar
    var img = document.querySelector('img[class*="avatar"]') ||
              document.querySelector('img[src*="tiktokcdn"]');
    r.avatarUrl = img ? img.getAttribute('src') : null;

    return JSON.stringify(r);
  `,
  );

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(String(raw));
  } catch {
    return null;
  }

  const bio = String(data.bio || "");

  return {
    platform: "tiktok",
    username,
    displayName: String(data.displayName || username),
    profileUrl: `https://www.tiktok.com/@${username}`,
    bio,
    followers: parseFollowerCount(String(data.followers || "")),
    followersDisplay: String(data.followers || "unknown"),
    following: parseFollowerCount(String(data.following || "")),
    postCount: undefined,
    isVerified: Boolean(data.isVerified),
    avatarUrl: data.avatarUrl ? String(data.avatarUrl) : undefined,
    engagementRate: undefined,
    avgLikes: undefined,
    avgComments: undefined,
    contentThemes: extractThemes(bio, criteria.query),
    recentPosts: [],
    relevanceScore: 0,
  };
}

// ---------------------------------------------------------------------------
// X / Twitter scraping
// ---------------------------------------------------------------------------

/**
 * Search X/Twitter for influencers by keyword.
 *
 * X has a people search at /search?q=...&f=user. Results are rendered as
 * [data-testid="UserCell"] components. Each cell's innerText follows this
 * pattern:
 *
 *   [Followed by X and Y others]   (optional social proof line)
 *   Display Name
 *   @username
 *   Follow
 *   Bio text...
 *
 * We parse the @username from the text (the DOM selector approach picks up
 * "Followed by..." text instead of handles). After extracting from search,
 * we visit each profile to get follower counts since the search page doesn't
 * include them.
 *
 * NOTE: Keep search queries SHORT (2-4 words). X returns "No results" for
 * long multi-word people searches.
 */
async function searchTwitter(
  criteria: InfluencerSearchCriteria,
): Promise<InfluencerProfile[]> {
  const limit = criteria.limit ?? 10;
  const tabId = await findOrOpenTab("*://*.x.com/*", "https://x.com");

  // Use a short query — X people search fails with long queries
  const queryWords = criteria.query.split(/\s+/).slice(0, 4).join(" ");
  const searchUrl = `https://x.com/search?q=${encodeURIComponent(
    queryWords,
  )}&f=user`;
  await navigateTab(tabId, searchUrl);
  await sleep(4000);

  // Scroll to load more results
  await evalInTab(tabId, `window.scrollTo(0, 800); return 'ok'`);
  await sleep(2000);
  await evalInTab(
    tabId,
    `window.scrollTo(0, document.body.scrollHeight); return 'ok'`,
  );
  await sleep(2000);

  // Extract profiles from UserCell components using text pattern parsing
  const raw = await evalInTab(
    tabId,
    `
    var cells = document.querySelectorAll('[data-testid="UserCell"]');
    var results = [];
    var seen = {};
    for (var j = 0; j < cells.length; j++) {
      var text = cells[j].innerText;
      var lines = text.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

      var username = '';
      var displayName = '';
      var bio = '';
      for (var k = 0; k < lines.length; k++) {
        var m = lines[k].match(/^@([a-zA-Z0-9_]+)$/);
        if (m) {
          username = m[1];
          // Display name is the line before @username (unless it's "Followed by...")
          if (k > 0 && !lines[k-1].startsWith('Followed')) {
            displayName = lines[k-1];
          } else if (k > 1) {
            displayName = lines[k-2] || '';
          }
          // Bio is everything after "Follow" button text
          var afterFollow = false;
          for (var n = k + 1; n < lines.length; n++) {
            if (lines[n] === 'Follow') { afterFollow = true; continue; }
            if (afterFollow) {
              bio = lines.slice(n).join(' ').substring(0, 250);
              break;
            }
          }
          break;
        }
      }

      if (!username || seen[username]) continue;
      seen[username] = true;
      if (!displayName || displayName.startsWith('Followed')) displayName = username;

      var verified = !!cells[j].querySelector('svg[data-testid="icon-verified"]');
      var img = cells[j].querySelector('img[src*="profile_images"]');

      results.push({
        username: username,
        displayName: displayName,
        bio: bio,
        isVerified: verified,
        avatarUrl: img ? img.getAttribute('src') : null,
      });
    }
    return JSON.stringify(results.slice(0, ${limit * 3}));
  `,
  );

  let searchResults: Array<{
    username: string;
    displayName: string;
    bio: string;
    isVerified: boolean;
    avatarUrl: string | null;
  }>;
  try {
    searchResults = JSON.parse(String(raw));
  } catch {
    return [];
  }

  if (searchResults.length === 0) return [];

  // Visit each profile to get follower counts (search results don't include them)
  const profiles: InfluencerProfile[] = [];
  for (const sr of searchResults.slice(0, limit)) {
    try {
      const profile = await scrapeTwitterProfile(tabId, sr.username, criteria);
      if (profile && matchesCriteria(profile, criteria)) {
        profiles.push(profile);
      }
      await sleep(1500);
    } catch {
      // Still include with search data if profile visit fails
      profiles.push({
        platform: "twitter",
        username: sr.username,
        displayName: sr.displayName,
        profileUrl: `https://x.com/${sr.username}`,
        bio: sr.bio,
        followers: undefined,
        followersDisplay: "unknown",
        following: undefined,
        postCount: undefined,
        isVerified: sr.isVerified,
        avatarUrl: sr.avatarUrl ?? undefined,
        engagementRate: undefined,
        avgLikes: undefined,
        avgComments: undefined,
        contentThemes: extractThemes(sr.bio, criteria.query),
        recentPosts: [],
        relevanceScore: 0,
      });
    }
  }

  return profiles;
}

/**
 * Scrape a single X/Twitter profile page for detailed stats.
 *
 * Uses a combination of data-testid selectors (reliable on X) and body text
 * regex for follower/following counts. The data-testid="UserName",
 * data-testid="UserDescription" selectors work well on X profile pages.
 * Follower counts are extracted from body text as the DOM structure for
 * stat links varies.
 */
async function scrapeTwitterProfile(
  tabId: number,
  username: string,
  _criteria: InfluencerSearchCriteria,
): Promise<InfluencerProfile | null> {
  await navigateTab(tabId, `https://x.com/${username}`);
  await sleep(2500);

  const raw = await evalInTab(
    tabId,
    `
    var r = { username: '${username}' };

    // Display name from UserName testid
    var nameEl = document.querySelector('[data-testid="UserName"]');
    if (nameEl) {
      var spans = nameEl.querySelectorAll('span');
      if (spans.length > 0) r.displayName = spans[0].textContent.trim();
    }

    // Bio from UserDescription testid
    var bioEl = document.querySelector('[data-testid="UserDescription"]');
    r.bio = bioEl ? bioEl.textContent.trim() : '';

    // Follower/following counts from body text (most reliable)
    var bodyText = document.body.innerText;
    var fMatch = bodyText.match(/([\\.\\d,]+[KkMm]?)\\s*Follower/);
    var fgMatch = bodyText.match(/([\\.\\d,]+[KkMm]?)\\s*Following/);
    r.followers = fMatch ? fMatch[1] : '';
    r.following = fgMatch ? fgMatch[1] : '';

    // Verified
    r.isVerified = !!document.querySelector('svg[data-testid="icon-verified"]') ||
                   !!document.querySelector('[aria-label*="Verified"]');

    // Avatar
    var img = document.querySelector('img[src*="profile_images"]');
    r.avatarUrl = img ? img.getAttribute('src') : null;

    return JSON.stringify(r);
  `,
  );

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(String(raw));
  } catch {
    return null;
  }

  return {
    platform: "twitter",
    username,
    displayName: String(data.displayName || username),
    profileUrl: `https://x.com/${username}`,
    bio: String(data.bio || ""),
    followers: parseFollowerCount(String(data.followers || "")),
    followersDisplay: String(data.followers || "unknown"),
    following: parseFollowerCount(String(data.following || "")),
    postCount: undefined,
    isVerified: Boolean(data.isVerified),
    avatarUrl: data.avatarUrl ? String(data.avatarUrl) : undefined,
    engagementRate: undefined,
    avgLikes: undefined,
    avgComments: undefined,
    contentThemes: extractThemes(String(data.bio || ""), ""),
    recentPosts: [],
    relevanceScore: 0,
  };
}

// ---------------------------------------------------------------------------
// Scoring & filtering
// ---------------------------------------------------------------------------

function matchesCriteria(
  profile: InfluencerProfile,
  criteria: InfluencerSearchCriteria,
): boolean {
  if (criteria.minFollowers && profile.followers !== undefined) {
    if (profile.followers < criteria.minFollowers) return false;
  }
  if (criteria.maxFollowers && profile.followers !== undefined) {
    if (profile.followers > criteria.maxFollowers) return false;
  }
  if (criteria.verifiedOnly && !profile.isVerified) {
    return false;
  }
  return true;
}

function scoreProfile(
  profile: InfluencerProfile,
  criteria: InfluencerSearchCriteria,
): number {
  let score = 0;

  // Follower count scoring
  if (profile.followers !== undefined) {
    if (profile.followers >= 1_000) score += 10;
    if (profile.followers >= 10_000) score += 20;
    if (profile.followers >= 100_000) score += 30;
    if (profile.followers >= 1_000_000) score += 20;

    // Bonus for being within requested range
    if (criteria.minFollowers && criteria.maxFollowers) {
      const mid = (criteria.minFollowers + criteria.maxFollowers) / 2;
      const distance = Math.abs(profile.followers - mid) / mid;
      score += Math.max(0, 20 - distance * 20);
    }
  }

  // Verified boost
  if (profile.isVerified) score += 15;

  // Bio relevance
  const queryTerms = criteria.query.toLowerCase().split(/\s+/);
  const bioLower = profile.bio.toLowerCase();
  for (const term of queryTerms) {
    if (bioLower.includes(term)) score += 10;
  }

  // Content theme matching
  if (profile.contentThemes.length > 0)
    score += 5 * profile.contentThemes.length;

  // Completeness bonuses
  if (profile.avatarUrl) score += 5;
  if (profile.bio.length > 20) score += 5;

  return score;
}

function extractThemes(bio: string, query: string): string[] {
  const themes: string[] = [];
  const text = (bio + " " + query).toLowerCase();

  const themeKeywords: Record<string, string[]> = {
    fashion: [
      "fashion",
      "style",
      "outfit",
      "ootd",
      "clothing",
      "wear",
      "designer",
    ],
    beauty: ["beauty", "makeup", "skincare", "cosmetic", "hair", "glow"],
    fitness: [
      "fitness",
      "gym",
      "workout",
      "health",
      "training",
      "athlete",
      "sports",
    ],
    food: ["food", "recipe", "cooking", "chef", "foodie", "restaurant", "eat"],
    travel: [
      "travel",
      "wanderlust",
      "adventure",
      "explore",
      "tourism",
      "destination",
    ],
    tech: [
      "tech",
      "technology",
      "gadget",
      "software",
      "coding",
      "developer",
      "ai",
      "artificial intelligence",
    ],
    gaming: ["gaming", "gamer", "esports", "twitch", "stream", "game"],
    music: ["music", "musician", "singer", "artist", "producer", "dj"],
    lifestyle: ["lifestyle", "daily", "vlog", "life", "mom", "dad", "family"],
    business: [
      "business",
      "entrepreneur",
      "startup",
      "marketing",
      "ceo",
      "founder",
    ],
    photography: ["photo", "photography", "photographer", "visual", "creative"],
    comedy: ["comedy", "funny", "humor", "meme", "comedian", "laugh"],
    education: [
      "education",
      "learn",
      "teach",
      "tutor",
      "tips",
      "howto",
      "teaching",
    ],
    wellness: [
      "wellness",
      "mindfulness",
      "meditation",
      "yoga",
      "mental health",
    ],
    career: [
      "career",
      "job",
      "hiring",
      "resume",
      "interview",
      "salary",
      "remote work",
    ],
  };

  for (const [theme, keywords] of Object.entries(themeKeywords)) {
    if (keywords.some((kw) => text.includes(kw))) {
      themes.push(theme);
    }
  }

  return themes;
}

// ---------------------------------------------------------------------------
// Main search orchestrator
// ---------------------------------------------------------------------------

/**
 * Search for influencers across specified platforms.
 */
export async function searchInfluencers(
  criteria: InfluencerSearchCriteria,
): Promise<InfluencerSearchResult[]> {
  const platforms = criteria.platforms ?? ["instagram", "tiktok", "twitter"];
  const results: InfluencerSearchResult[] = [];

  for (const platform of platforms) {
    try {
      let profiles: InfluencerProfile[];

      switch (platform) {
        case "instagram":
          profiles = await searchInstagram(criteria);
          break;
        case "tiktok":
          profiles = await searchTikTok(criteria);
          break;
        case "twitter":
          profiles = await searchTwitter(criteria);
          break;
        default:
          continue;
      }

      // Score and sort
      profiles = profiles.map((p) => ({
        ...p,
        relevanceScore: scoreProfile(p, criteria),
      }));
      profiles.sort((a, b) => b.relevanceScore - a.relevanceScore);

      results.push({
        platform,
        profiles,
        count: profiles.length,
        query: criteria.query,
      });
    } catch (err) {
      results.push({
        platform,
        profiles: [],
        count: 0,
        query: criteria.query,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

/**
 * Get detailed profile data for a specific influencer.
 */
export async function getInfluencerProfile(
  platform: "instagram" | "tiktok" | "twitter",
  username: string,
): Promise<InfluencerProfile | null> {
  const criteria: InfluencerSearchCriteria = { query: "" };

  switch (platform) {
    case "instagram": {
      const tabId = await findOrOpenTab(
        "*://*.instagram.com/*",
        "https://www.instagram.com",
      );
      return scrapeInstagramProfile(tabId, username, criteria);
    }
    case "twitter": {
      const tabId = await findOrOpenTab("*://*.x.com/*", "https://x.com");
      return scrapeTwitterProfile(tabId, username, criteria);
    }
    case "tiktok": {
      const tabId = await findOrOpenTab(
        "*://*.tiktok.com/*",
        "https://www.tiktok.com",
      );
      return scrapeTikTokProfile(tabId, username, criteria);
    }
    default:
      return null;
  }
}

/**
 * Compare multiple influencers side by side.
 */
export async function compareInfluencers(
  influencers: {
    platform: "instagram" | "tiktok" | "twitter";
    username: string;
  }[],
): Promise<InfluencerProfile[]> {
  const profiles: InfluencerProfile[] = [];

  for (const inf of influencers) {
    const profile = await getInfluencerProfile(inf.platform, inf.username);
    if (profile) {
      profiles.push(profile);
    }
    await sleep(2000);
  }

  return profiles;
}
