import { describe, expect, it } from "bun:test";

import {
  buildSlackManifest,
  SLACK_MANIFEST_BOT_SCOPES,
} from "./slack-manifest";

const manifest = buildSlackManifest("Example Assistant");
const scopes = manifest.oauth_config.scopes;

describe("oauth scopes", () => {
  // Slack reads `bot`/`user` as the complete request and the `_optional`
  // arrays as an opt-out subset within it. A scope listed only in the optional
  // array is never requested at all, which is silent and easy to reintroduce.
  it("keeps bot_optional a subset of bot", () => {
    const bot = new Set<string>(scopes.bot);
    expect(scopes.bot_optional.filter((s) => !bot.has(s))).toEqual([]);
  });

  it("keeps user_optional a subset of user", () => {
    const user = new Set<string>(scopes.user);
    expect(scopes.user_optional.filter((s) => !user.has(s))).toEqual([]);
  });

  it("exposes the full bot request to the scope-drift probe", () => {
    expect([...SLACK_MANIFEST_BOT_SCOPES].sort()).toEqual(
      [...scopes.bot].sort(),
    );
  });

  it("requests no duplicate scopes", () => {
    expect(new Set(scopes.bot).size).toBe(scopes.bot.length);
    expect(new Set(scopes.user).size).toBe(scopes.user.length);
  });
});

describe("agent_view", () => {
  it("uses agent_description, not the assistant_view spelling", () => {
    const view = manifest.features.agent_view as Record<string, unknown>;
    expect(view.agent_description).toBe("Example Assistant");
    expect(view).not.toHaveProperty("assistant_description");
  });

  it("carries suggested_prompts over", () => {
    expect(manifest.features.agent_view.suggested_prompts).toEqual([]);
  });

  it("subscribes to app_context_changed, which agent_view unlocks", () => {
    expect(manifest.settings.event_subscriptions.bot_events).toContain(
      "app_context_changed",
    );
  });

  it("subscribes to both directions of a reaction, since both are handled", () => {
    // The daemon dispatches reactions by `callbackData` prefix and handles
    // `reaction_removed:` as its own case, persisting the removal so a
    // transcript shows it. Both directions have to be subscribed for that to
    // run. Asserted as a pair, because a subscription dropped on one side is
    // invisible from the handler: the code still reads as working and simply
    // never receives anything.
    const events = manifest.settings.event_subscriptions.bot_events;
    expect(events).toContain("reaction_added");
    expect(events).toContain("reaction_removed");
  });
});

describe("field limits", () => {
  it("clamps the display description to 140 characters", () => {
    const built = buildSlackManifest("Bot", "x".repeat(400));
    expect(built.display_information.description).toHaveLength(140);
  });

  it("clamps the agent description to 300 characters", () => {
    const built = buildSlackManifest("Bot", "x".repeat(400));
    expect(built.features.agent_view.agent_description).toHaveLength(300);
  });

  it("clamps the name to 35 characters and falls back when blank", () => {
    expect(
      buildSlackManifest("A".repeat(50)).display_information.name,
    ).toHaveLength(35);
    expect(buildSlackManifest("   ").display_information.name).toBe(
      "My Assistant",
    );
  });

  it("omits description entirely when none is given", () => {
    expect(buildSlackManifest("Bot").display_information).not.toHaveProperty(
      "description",
    );
  });
});

describe("JSON round-trip", () => {
  // LUM-704: symbols in the assistant name used to break the generated
  // manifest. The manifest travels through the clipboard, so what matters is
  // that stringify/parse preserves them intact for the paste. The slash and
  // quotes are the payload here — the name itself is a generic placeholder.
  it("round-trips a name and description containing symbols", () => {
    const built = buildSlackManifest(
      "Example Assistant 24/7",
      'Ops & "stuff" <3',
    );
    const parsed = JSON.parse(JSON.stringify(built));

    expect(parsed.display_information.name).toBe("Example Assistant 24/7");
    expect(parsed.display_information.description).toBe('Ops & "stuff" <3');
    expect(parsed.features.agent_view.agent_description).toBe(
      'Ops & "stuff" <3',
    );
  });

  it("produces valid JSON for the clipboard", () => {
    const text = JSON.stringify(
      buildSlackManifest("Example Assistant 24/7"),
      null,
      2,
    );

    expect(() => JSON.parse(text)).not.toThrow();
  });
});
