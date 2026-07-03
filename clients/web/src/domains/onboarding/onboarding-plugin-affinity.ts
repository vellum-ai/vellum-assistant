/**
 * Deterministic plugin floor for research-onboarding.
 *
 * The research turn asks the model to pick capabilities that fit the person (a
 * top-level `plugins` array), but the prompt biases toward fewer picks — so
 * cases we want to happen *reliably* (admin-copilot for everyone; marketing for
 * a founder; git tooling for an engineer) lose to that bias. This module is the
 * deterministic complement: an always-install baseline plus a role-keyword
 * affinity map, both narrowed to the live catalog by the runner. The model layer
 * still covers the long tail of roles not enumerated here.
 *
 * Lives in the onboarding domain on purpose: a role → capability affinity is
 * onboarding's own concern, not knowledge reached in from the chat/plugin domain.
 * Keep the keyword lists lean and high-precision; a false match silently installs
 * an off-topic plugin for a new user, which is worse than a miss the model can
 * still catch.
 *
 * INTENTIONAL EXCEPTION to the "Assistant-Driven Judgement" rule in the root
 * AGENTS.md (judgement calls route through the daemon, not client heuristics).
 * This is a stakeholder-agreed deterministic FLOOR layered under the model's own
 * picks, not a replacement for them: the research turn already asks the assistant
 * to judge fit, but its prompt biases toward fewer picks, so the cases we require
 * to be reliable (admin-copilot for everyone; marketing for a founder) kept
 * getting dropped. The always-install baseline is a product POLICY, not a
 * judgement; the role map is a narrow, high-precision safety net for the obvious
 * hits while the model continues to cover the long tail. Prefer a miss (let the
 * model decide) over a loose keyword that mis-installs.
 */

/**
 * Capabilities installed for every new user, regardless of role — a universal
 * baseline that should never be left to the model's discretion. Still gated by
 * the runner against the live catalog (owner/enabled checks), so a name absent
 * from the marketplace is simply skipped.
 */
export const ALWAYS_INSTALL_PLUGINS: readonly string[] = ["admin-copilot"];

/**
 * Role-keyword → capability affinity. A capability is selected when any of its
 * keywords appears as a whole token (or contiguous token phrase) in the person's
 * stated role. Matching is whole-token by construction (see `matchesKeyword`), so
 * "dev" never fires on "developer" and "architect" phrases stay scoped — list the
 * exact forms you mean.
 */
interface PluginAffinity {
  plugin: string;
  keywords: readonly string[];
}

const PLUGIN_AFFINITIES: readonly PluginAffinity[] = [
  {
    // Founders/execs do their own GTM, and the marketing roles are direct hits.
    // marketing-expert spans positioning, demand, content, funnel, and sales
    // motion, so the sales/creator roles fold in here too.
    plugin: "marketing-expert",
    keywords: [
      "founder",
      "cofounder",
      "co founder",
      "ceo",
      "cmo",
      "chief executive",
      "chief marketing",
      "entrepreneur",
      "marketing",
      "marketer",
      "growth",
      "brand",
      "content",
      "copywriter",
      "copywriting",
      "seo",
      "demand gen",
      "demand generation",
      "sales",
      "account executive",
      "business development",
      "creator",
      "social media",
      "community manager",
    ],
  },
  {
    // Software-engineering roles only. Deliberately NO bare "engineer" or
    // "software" token — those over-match the non-software engineering
    // disciplines ("Mechanical Engineer", "Civil Engineer") and adjacent titles
    // ("Software Product Manager"), silently installing code tooling for someone
    // who doesn't ship code. Match the qualified phrases instead; "developer"
    // stays bare since its dominant occupational sense is software (the rare
    // "real estate developer" is an acceptable miss). Genuinely git-adjacent
    // roles (data scientist, analyst, PM) are left to the model.
    plugin: "git-workflow",
    keywords: [
      "developer",
      "swe",
      "programmer",
      "coder",
      "devops",
      "dev ops",
      "sre",
      "site reliability",
      "software engineer",
      "software architect",
      "backend engineer",
      "back end engineer",
      "frontend engineer",
      "front end engineer",
      "full stack engineer",
      "fullstack engineer",
      "platform engineer",
      "infrastructure engineer",
      "data engineer",
      "machine learning engineer",
      "ml engineer",
      "qa engineer",
      "embedded engineer",
      "security engineer",
      "staff engineer",
      "principal engineer",
      "solutions architect",
      "tech lead",
      "technical lead",
      "engineering manager",
      "engineering lead",
      "head of engineering",
      "director of engineering",
      "vp of engineering",
      "vp engineering",
      "cto",
    ],
  },
];

/**
 * Normalize a free-text role to a space-padded, alphanumeric-token string so
 * keyword tests are whole-token: every run of non-alphanumerics collapses to a
 * single space and the whole string is wrapped in spaces. "Founder / CEO" →
 * " founder ceo ", so `includes(" ceo ")` matches but `includes(" dev ")` can't
 * match inside "developer".
 */
function normalizeRole(role: string): string {
  return ` ${role.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/** Whether a keyword (single token or token phrase) appears whole in the role. */
function matchesKeyword(normalizedRole: string, keyword: string): boolean {
  return normalizedRole.includes(` ${keyword} `);
}

/**
 * Plugins implied by a role on its own (excludes the always-install baseline),
 * before any catalog narrowing. Order follows `PLUGIN_AFFINITIES`; deduped.
 * Exported for unit tests; the runner uses {@link resolveDeterministicPlugins}.
 */
export function pluginsForRole(role: string): string[] {
  const normalized = normalizeRole(role);
  const matched: string[] = [];
  for (const { plugin, keywords } of PLUGIN_AFFINITIES) {
    if (keywords.some((kw) => matchesKeyword(normalized, kw))) {
      matched.push(plugin);
    }
  }
  return matched;
}

/**
 * The deterministic install set for a run: the always-install baseline unioned
 * with the role's affinity matches, narrowed to capabilities actually present in
 * the fetched catalog (`validNames`) so a name the marketplace doesn't carry —
 * or that's filtered out (non-Vellum, infra) — never hits the install route.
 * Baseline first, then role matches; deduped, order-stable.
 */
export function resolveDeterministicPlugins(
  role: string,
  validNames: Set<string>,
): string[] {
  const ordered = [...ALWAYS_INSTALL_PLUGINS, ...pluginsForRole(role)];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of ordered) {
    if (!validNames.has(name) || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}
