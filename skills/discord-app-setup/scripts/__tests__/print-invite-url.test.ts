import { describe, expect, test } from "bun:test";

import {
  planInvite,
  permissionWarnings,
  readApplication,
  type DiscordApplication,
} from "../print-invite-url.ts";

/** The permission integer the fallback URL requests. */
const REQUESTED_DEFAULT = "277025770560";
/** VIEW_CHANNEL + SEND_MESSAGES + ATTACH_FILES + SEND_MESSAGES_IN_THREADS. */
const REQUIRED_ONLY = (
  (1n << 10n) |
  (1n << 11n) |
  (1n << 15n) |
  (1n << 38n)
).toString();

function app(
  installSettings: DiscordApplication["installSettings"],
): DiscordApplication {
  return { id: "123456789012345678", installSettings };
}

describe("readApplication", () => {
  test("reads the Installation page's settings from integration_types_config", () => {
    const parsed = readApplication({
      id: "1",
      integration_types_config: {
        "0": {
          oauth2_install_params: { scopes: ["bot"], permissions: "2048" },
        },
        "1": { oauth2_install_params: { scopes: ["applications.commands"] } },
      },
    });
    // The guild-install entry, not the user-install one: this skill performs
    // a server install.
    expect(parsed.installSettings).toEqual({
      scopes: ["bot"],
      permissions: "2048",
    });
  });

  test("falls back to the legacy in-app authorization settings", () => {
    const parsed = readApplication({
      id: "1",
      install_params: { scopes: ["bot"], permissions: "8" },
    });
    expect(parsed.installSettings).toEqual({
      scopes: ["bot"],
      permissions: "8",
    });
  });

  test("prefers the portal's settings when both exist", () => {
    // The portal writes integration_types_config; a stale legacy block must
    // not shadow what the admin actually edits.
    const parsed = readApplication({
      id: "1",
      install_params: { scopes: ["identify"] },
      integration_types_config: {
        "0": { oauth2_install_params: { scopes: ["bot"] } },
      },
    });
    expect(parsed.installSettings?.scopes).toEqual(["bot"]);
  });

  test("an app with no settings anywhere has none", () => {
    expect(readApplication({ id: "1" }).installSettings).toBeUndefined();
  });

  test("filters non-string scope members instead of rejecting the app", () => {
    const parsed = readApplication({
      id: "1",
      integration_types_config: {
        "0": { oauth2_install_params: { scopes: [42, "bot"] } },
      },
    });
    expect(parsed.installSettings?.scopes).toEqual(["bot"]);
  });

  test("refuses a response without a usable id", () => {
    expect(() => readApplication({ id: "" })).toThrow(/usable id/);
    expect(() => readApplication(null)).toThrow(/non-object/);
  });
});

describe("planInvite", () => {
  test("no install settings: the URL spells out the grant, bot scope only", () => {
    const plan = planInvite(app(undefined));
    const url = new URL(plan.url);
    expect(url.searchParams.get("client_id")).toBe("123456789012345678");
    expect(url.searchParams.get("scope")).toBe("bot");
    expect(url.searchParams.get("permissions")).toBe(REQUESTED_DEFAULT);
    expect(plan.notes).toEqual([]);
  });

  test("install settings: the URL carries only the client id", () => {
    const plan = planInvite(
      app({ scopes: ["bot"], permissions: REQUESTED_DEFAULT }),
    );
    const url = new URL(plan.url);
    expect(url.searchParams.get("scope")).toBeNull();
    expect(url.searchParams.get("permissions")).toBeNull();
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]).toContain("Default Install Settings");
  });

  test("settings without the bot scope stop the plan instead of printing", () => {
    // A client-id-only link would install whatever the settings say, which
    // here adds no bot user at all: the setup flow would dead-end on a URL
    // that looked right.
    expect(() =>
      planInvite(app({ scopes: ["applications.commands"], permissions: "0" })),
    ).toThrow(/bot scope/);
  });

  test("surplus scopes warn, naming gdm.join's group-DM consequence", () => {
    const plan = planInvite(
      app({ scopes: ["bot", "gdm.join"], permissions: REQUESTED_DEFAULT }),
    );
    const warning = plan.notes.find((n) => n.startsWith("Warning"));
    expect(warning).toContain("gdm.join");
    expect(warning).toContain("private DMs");
  });

  test("settings tightened below the requested default but covering the used bits pass silently", () => {
    // The requested default includes bits nothing exercises (reactions,
    // external emojis, slash commands). An admin who removes those has
    // improved the install and must not be told to widen it back.
    const plan = planInvite(
      app({ scopes: ["bot"], permissions: REQUIRED_ONLY }),
    );
    expect(plan.notes.filter((n) => n.startsWith("Warning"))).toEqual([]);
  });
});

describe("permissionWarnings", () => {
  test("Administrator warns toward the least-privilege integer", () => {
    const warnings = permissionWarnings("8");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Administrator");
    expect(warnings[0]).toContain(REQUESTED_DEFAULT);
  });

  test("missing exercised bits warn by name", () => {
    // VIEW_CHANNEL + SEND_MESSAGES only: the bot could talk but not upload
    // or answer in threads.
    const warnings = permissionWarnings(((1n << 10n) | (1n << 11n)).toString());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ATTACH_FILES");
    expect(warnings[0]).toContain("SEND_MESSAGES_IN_THREADS");
    expect(warnings[0]).not.toContain("ADD_REACTIONS");
  });

  test("the exact requested default is silent", () => {
    expect(permissionWarnings(REQUESTED_DEFAULT)).toEqual([]);
  });

  test("absent or malformed permission strings validate nothing", () => {
    expect(permissionWarnings(undefined)).toEqual([]);
    expect(permissionWarnings("not-a-number")).toEqual([]);
  });
});
