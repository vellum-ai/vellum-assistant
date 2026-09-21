import { describe, expect, test } from "bun:test";

import {
  ABOUT_ASSISTANT_SECTIONS,
  aboutAssistantSectionForPath,
  appIdForPath,
  conversationIdForPath,
  isAboutAssistantPath,
  isConversationChatPath,
  isConversationPath,
  isPathExactly,
  routes,
} from "@/utils/routes";
import {
  ENCODED_APP_PATH,
  ENCODED_SLASH_APP_PATH,
  ESCAPED_CONVERSATIONS_PREFIX,
  ESCAPED_PREFIX_APP_PATH,
  MALFORMED_APP_PATH,
  MALFORMED_CONVERSATION_PATH,
  MALFORMED_CONVERSATION_WITH_APP_PATH,
  MALFORMED_ESCAPE,
  RAW_ENCODED_SLASH_APP_PATH,
} from "@/utils/routes.test-helper";

/** The escaped prefix spelling on a bare conversation route. */
const ESCAPED_PREFIX_CONVERSATION_PATH = `${ESCAPED_CONVERSATIONS_PREFIX}/c1`;

describe("routes", () => {
  test("builds schedule-filtered usage URLs", () => {
    expect(routes.settings.usageForSchedule("schedule-123")).toBe(
      "/assistant/settings/usage?tab=usage&range=7d&groupBy=schedule&scheduleId=schedule-123",
    );
  });

  test("encodes schedule ids in usage URLs", () => {
    expect(routes.settings.usageForSchedule("schedule with spaces")).toBe(
      "/assistant/settings/usage?tab=usage&range=7d&groupBy=schedule&scheduleId=schedule+with+spaces",
    );
  });

  test("builds the schedules tab and per-schedule detail paths", () => {
    expect(routes.schedules.root).toBe("/assistant/schedules");
    expect(routes.schedules.detail("sch_123")).toBe(
      "/assistant/schedules/sch_123",
    );
  });

  test("builds the contacts list and per-contact detail paths", () => {
    expect(routes.contacts.root).toBe("/assistant/contacts");
    expect(routes.contacts.detail("c_1")).toBe("/assistant/contacts/c_1");
  });

  test("builds the superpowers list and per-skill detail paths", () => {
    expect(routes.superpowers).toBe("/assistant/superpowers");
    expect(routes.skills.root).toBe("/assistant/skills");
    expect(routes.skills.detail("my-skill")).toBe("/assistant/skills/my-skill");
  });

  test("appends the app segment to conversation URLs when given an app id", () => {
    expect(routes.conversation("c1", "app-1")).toBe(
      "/assistant/conversations/c1/app/app-1",
    );
  });

  test("leaves conversation URLs untouched without an app id", () => {
    expect(routes.conversation("c1")).toBe("/assistant/conversations/c1");
    expect(routes.conversation("c1", null)).toBe("/assistant/conversations/c1");
  });

  test("puts the app segment before the message and prompt params", () => {
    expect(routes.conversationAtMessage("c1", "m1", "app-1")).toBe(
      "/assistant/conversations/c1/app/app-1?message=m1",
    );
    expect(routes.conversationAtMessage("c1", "m1")).toBe(
      "/assistant/conversations/c1?message=m1",
    );
    expect(routes.conversationWithPrompt("c1", "hi", undefined, "app-1")).toBe(
      "/assistant/conversations/c1/app/app-1?prompt=hi",
    );
    expect(routes.conversationWithPrompt("c1", "hi")).toBe(
      "/assistant/conversations/c1?prompt=hi",
    );
  });

  test("encodes contact ids into a single path segment", () => {
    // Contact ids are caller-supplied, so a slash or a space must not split
    // the segment or leave the URL unparseable.
    expect(routes.contacts.detail("org/team c_1")).toBe(
      "/assistant/contacts/org%2Fteam%20c_1",
    );
  });

  test("encodes namespaced skill ids into a single path segment", () => {
    // skills.sh catalog ids contain slashes (org/repo/skill); the produced
    // URL must keep the id as ONE segment so `skills/:skillId` can match it.
    expect(routes.skills.detail("org/repo/shared-skill")).toBe(
      "/assistant/skills/org%2Frepo%2Fshared-skill",
    );
  });
});

describe("isAboutAssistantPath", () => {
  test("matches the drill-down sections, including schedule detail sub-paths", () => {
    expect(isAboutAssistantPath(routes.identity)).toBe(true);
    expect(isAboutAssistantPath(routes.superpowers)).toBe(true);
    expect(isAboutAssistantPath(routes.skills.root)).toBe(true);
    expect(isAboutAssistantPath(routes.schedules.root)).toBe(true);
    expect(isAboutAssistantPath(routes.schedules.detail("sch_123"))).toBe(true);
  });

  test("matches the Library section, including the app viewer sub-path", () => {
    expect(isAboutAssistantPath(routes.library.root)).toBe(true);
    expect(isAboutAssistantPath(routes.library.app("app-1"))).toBe(true);
  });

  test("matches the Contacts section, including a contact detail path", () => {
    expect(isAboutAssistantPath(routes.contacts.root)).toBe(true);
    expect(isAboutAssistantPath(routes.contacts.detail("c_1"))).toBe(true);
    expect(
      aboutAssistantSectionForPath(routes.contacts.detail("c_1"))?.key,
    ).toBe("contacts");
  });

  test("every registry section counts as an About Assistant path", () => {
    // Chrome and sidebar highlight derive from the same registry — this
    // guards the wiring, so a new section can't get one without the other.
    for (const { to } of ABOUT_ASSISTANT_SECTIONS) {
      expect(isAboutAssistantPath(to)).toBe(true);
    }
  });

  test("rejects settings and conversations", () => {
    expect(isAboutAssistantPath(routes.settings.root)).toBe(false);
    expect(isAboutAssistantPath(routes.conversation("conv-1"))).toBe(false);
  });
});

describe("isPathExactly (the route itself, trailing slash tolerated)", () => {
  test("matches the path and its single-trailing-slash spelling", () => {
    expect(isPathExactly(routes.contacts.root, routes.contacts.root)).toBe(
      true,
    );
    expect(
      isPathExactly(`${routes.contacts.root}/`, routes.contacts.root),
    ).toBe(true);
  });

  test("rejects sub-paths, doubled slashes, and other routes", () => {
    expect(
      isPathExactly(`${routes.contacts.root}/c_1`, routes.contacts.root),
    ).toBe(false);
    expect(
      isPathExactly(`${routes.contacts.root}//`, routes.contacts.root),
    ).toBe(false);
    expect(isPathExactly(routes.library.root, routes.contacts.root)).toBe(
      false,
    );
  });
});

describe("isConversationPath (conversation area, subroutes included)", () => {
  test("matches the chat index and conversation routes", () => {
    expect(isConversationPath("/assistant")).toBe(true);
    expect(isConversationPath("/assistant/")).toBe(true);
    expect(isConversationPath(routes.conversation("conv-1"))).toBe(true);
  });

  test("matches conversation subroutes like the inspector", () => {
    expect(isConversationPath(routes.inspect("conv-1"))).toBe(true);
  });

  test("matches an escaped spelling of the prefix, as the router does", () => {
    const inspector = `${ESCAPED_PREFIX_CONVERSATION_PATH}/inspect`;
    expect(isConversationPath(ESCAPED_PREFIX_CONVERSATION_PATH)).toBe(true);
    // `isConversationChatPath` stays the stricter of the two: the inspector
    // falls inside the area and mounts no composer.
    expect(isConversationPath(inspector)).toBe(true);
    expect(isConversationChatPath(inspector)).toBe(false);
  });

  test("rejects non-conversation routes", () => {
    expect(isConversationPath("/assistant/identity")).toBe(false);
    expect(isConversationPath("/assistant/library")).toBe(false);
  });
});

describe("conversationIdForPath (the id a path names, if any)", () => {
  test("extracts the id from a bare conversation route", () => {
    expect(conversationIdForPath(routes.conversation("conv-1"))).toBe("conv-1");
  });

  test("tolerates a trailing slash", () => {
    expect(conversationIdForPath(`${routes.conversation("conv-1")}/`)).toBe(
      "conv-1",
    );
    expect(conversationIdForPath(`${routes.conversation("conv-1")}//`)).toBe(
      "conv-1",
    );
  });

  test("rejects the chat index, which names no conversation", () => {
    // `isConversationChatPath` accepts it (a composer mounts there), so the
    // two must stay distinguishable.
    expect(conversationIdForPath("/assistant")).toBeNull();
    expect(conversationIdForPath("/assistant/")).toBeNull();
    expect(isConversationChatPath("/assistant")).toBe(true);
  });

  test("rejects conversation subroutes like the inspector", () => {
    expect(conversationIdForPath(routes.inspect("conv-1"))).toBeNull();
  });

  test("extracts the id from the app viewer sub-route", () => {
    // `ChatPage` stays mounted there, so the path still names its conversation.
    expect(conversationIdForPath(routes.conversation("conv-1", "app-1"))).toBe(
      "conv-1",
    );
  });

  test("rejects a partial or over-long app sub-route", () => {
    expect(
      conversationIdForPath("/assistant/conversations/conv-1/app"),
    ).toBeNull();
    expect(
      conversationIdForPath("/assistant/conversations/conv-1/app/"),
    ).toBeNull();
    expect(
      conversationIdForPath("/assistant/conversations/conv-1/app/app-1/extra"),
    ).toBeNull();
  });

  test("rejects an app sub-route with an empty conversation id", () => {
    expect(
      conversationIdForPath("/assistant/conversations//app/app-1"),
    ).toBeNull();
  });

  test("rejects the conversations list, with or without a trailing slash", () => {
    expect(conversationIdForPath(routes.conversations)).toBeNull();
    expect(conversationIdForPath(`${routes.conversations}/`)).toBeNull();
  });

  test("rejects non-conversation routes", () => {
    expect(conversationIdForPath("/assistant/identity")).toBeNull();
    expect(conversationIdForPath("/assistant/library")).toBeNull();
  });

  test("decodes the id the browser percent-encoded", () => {
    expect(conversationIdForPath("/assistant/conversations/conv%201")).toBe(
      "conv 1",
    );
  });
});

describe("appIdForPath (the app a path keeps on screen, if any)", () => {
  test("extracts the app id from the app viewer sub-route", () => {
    expect(appIdForPath(routes.conversation("conv-1", "app-1"))).toBe("app-1");
    expect(appIdForPath(`${routes.conversation("conv-1", "app-1")}/`)).toBe(
      "app-1",
    );
  });

  test("returns null for a plain conversation route", () => {
    expect(appIdForPath(routes.conversation("conv-1"))).toBeNull();
  });

  test("returns null for the inspector and non-conversation routes", () => {
    expect(appIdForPath(routes.inspect("conv-1"))).toBeNull();
    expect(appIdForPath("/assistant")).toBeNull();
    expect(appIdForPath("/assistant/library")).toBeNull();
  });

  test("returns null when the conversation id is empty", () => {
    expect(appIdForPath("/assistant/conversations//app/app-1")).toBeNull();
  });

  test("decodes the segment, so it equals the id the viewer holds", () => {
    expect(appIdForPath(ENCODED_APP_PATH)).toBe("plugins~p~My App");
  });
});

describe("isConversationChatPath (composer-mounting routes only)", () => {
  test("matches the chat index (draft conversation)", () => {
    expect(isConversationChatPath("/assistant")).toBe(true);
    expect(isConversationChatPath("/assistant/")).toBe(true);
  });

  test("matches a bare conversation route, tolerating a trailing slash", () => {
    expect(isConversationChatPath(routes.conversation("conv-1"))).toBe(true);
    expect(isConversationChatPath(`${routes.conversation("conv-1")}/`)).toBe(
      true,
    );
  });

  test("rejects the inspector subroute — InspectPage has no composer", () => {
    expect(isConversationChatPath(routes.inspect("conv-1"))).toBe(false);
  });

  test("matches the app viewer sub-route, which keeps ChatPage mounted", () => {
    expect(isConversationChatPath(routes.conversation("conv-1", "app-1"))).toBe(
      true,
    );
  });

  test("rejects the conversations list prefix without an id", () => {
    expect(isConversationChatPath(`${routes.conversations}/`)).toBe(false);
  });

  test("rejects an app sub-route with an empty conversation id", () => {
    expect(isConversationChatPath("/assistant/conversations//app/app-1")).toBe(
      false,
    );
  });

  test("rejects non-conversation routes", () => {
    expect(isConversationChatPath("/assistant/identity")).toBe(false);
    expect(isConversationChatPath("/assistant/library")).toBe(false);
  });
});

describe("a malformed escape keeps its raw spelling, as the router does", () => {
  // React Router still matches the route, handing `useParams` the raw segment.
  test("in the conversation id", () => {
    expect(conversationIdForPath(MALFORMED_CONVERSATION_PATH)).toBe(
      MALFORMED_ESCAPE,
    );
    expect(appIdForPath(MALFORMED_CONVERSATION_PATH)).toBeNull();
    expect(isConversationChatPath(MALFORMED_CONVERSATION_PATH)).toBe(true);
  });

  test("in the app id", () => {
    const path = `/assistant/conversations/conv-1/app/${MALFORMED_ESCAPE}`;
    expect(conversationIdForPath(path)).toBe("conv-1");
    expect(appIdForPath(path)).toBe(MALFORMED_ESCAPE);
    expect(isConversationChatPath(path)).toBe(true);
  });

  test("leaves the app id raw when the conversation id is the bad one", () => {
    // The router decodes the whole path in one pass, so one bad escape leaves
    // the app's own good escape undecoded too.
    expect(conversationIdForPath(MALFORMED_CONVERSATION_WITH_APP_PATH)).toBe(
      MALFORMED_ESCAPE,
    );
    expect(appIdForPath(MALFORMED_CONVERSATION_WITH_APP_PATH)).toBe("My%20App");
  });

  test("leaves the conversation id raw when the app id is the bad one", () => {
    expect(conversationIdForPath(MALFORMED_APP_PATH)).toBe("conv%20x");
    expect(appIdForPath(MALFORMED_APP_PATH)).toBe(MALFORMED_ESCAPE);
  });
});

describe("an encoded slash comes back as a slash inside an id", () => {
  // `matchPath` restores `%2F` in every param, so an id holding a `/` reaches
  // `useParams` whole rather than splitting the segment it rode in.
  test("on the decoded path", () => {
    expect(appIdForPath(ENCODED_SLASH_APP_PATH)).toBe("a/b");
    expect(conversationIdForPath("/assistant/conversations/a%2Fb")).toBe("a/b");
  });

  test("and on the raw path a malformed escape leaves undecoded", () => {
    expect(conversationIdForPath(RAW_ENCODED_SLASH_APP_PATH)).toBe(
      MALFORMED_ESCAPE,
    );
    expect(appIdForPath(RAW_ENCODED_SLASH_APP_PATH)).toBe("a/b");
  });
});

describe("the prefix is read off the decoded path, as the router reads it", () => {
  test("an escaped spelling of the prefix still names the route", () => {
    expect(appIdForPath(ESCAPED_PREFIX_APP_PATH)).toBe("app-1");
    expect(conversationIdForPath(ESCAPED_PREFIX_CONVERSATION_PATH)).toBe("c1");
  });
});
