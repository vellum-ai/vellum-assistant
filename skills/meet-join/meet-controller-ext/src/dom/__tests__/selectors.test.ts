import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

import {
  GOOGLE_MEET_SELECTOR_VERSION,
  chatSelectors,
  controlSelectors,
  INGAME_ACTIVE_SPEAKER_INDICATOR,
  participantSelectors,
  prejoinSelectors,
  selectors,
} from "../selectors.js";

/**
 * Verifies every selector exported from `dom-selectors.ts` resolves against
 * the committed fixtures. When Meet's DOM drifts and a human developer
 * recaptures the fixture HTML, this suite is what tells us whether our
 * selectors still match — see README § "Refreshing Meet DOM fixtures".
 */

const FIXTURE_DIR = join(import.meta.dir, "fixtures");

function loadFixture(name: string): Document {
  const html = readFileSync(join(FIXTURE_DIR, name), "utf8");
  return new JSDOM(html).window.document;
}

describe("GOOGLE_MEET_SELECTOR_VERSION", () => {
  test("is a non-empty ISO-date-shaped string", () => {
    expect(typeof GOOGLE_MEET_SELECTOR_VERSION).toBe("string");
    expect(GOOGLE_MEET_SELECTOR_VERSION.length).toBeGreaterThan(0);
    // YYYY-MM-DD shape — doesn't validate the calendar, just the format.
    expect(GOOGLE_MEET_SELECTOR_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("prejoin selectors", () => {
  const doc = loadFixture("meet-dom-prejoin.html");

  test("NAME_INPUT resolves the name textbox", () => {
    const nodes = doc.querySelectorAll(prejoinSelectors.NAME_INPUT);
    expect(nodes.length).toBe(1);
    const input = nodes[0] as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.getAttribute("aria-label")).toBe("Your name");
  });

  test("MEDIA_PROMPT_ACCEPT_BUTTON resolves the media-permission accept button", () => {
    const nodes = doc.querySelectorAll(
      prejoinSelectors.MEDIA_PROMPT_ACCEPT_BUTTON,
    );
    expect(nodes.length).toBe(1);
    expect((nodes[0] as HTMLElement).tagName).toBe("BUTTON");
    expect((nodes[0] as HTMLElement).textContent?.trim()).toBe(
      "Use microphone and camera",
    );
  });

  test("ASK_TO_JOIN_BUTTON resolves the ask-to-join button", () => {
    const nodes = doc.querySelectorAll(prejoinSelectors.ASK_TO_JOIN_BUTTON);
    expect(nodes.length).toBe(1);
    expect((nodes[0] as HTMLElement).textContent?.trim()).toBe("Ask to join");
  });

  test("JOIN_NOW_BUTTON resolves the join-now button", () => {
    const nodes = doc.querySelectorAll(prejoinSelectors.JOIN_NOW_BUTTON);
    expect(nodes.length).toBe(1);
    expect((nodes[0] as HTMLElement).textContent?.trim()).toBe("Join now");
  });
});

describe("in-meeting selectors", () => {
  const doc = loadFixture("meet-dom-ingame.html");

  test("CAMERA_TOGGLE resolves exactly one toolbar button", () => {
    const nodes = doc.querySelectorAll(controlSelectors.CAMERA_TOGGLE);
    expect(nodes.length).toBe(1);
    expect((nodes[0] as HTMLElement).getAttribute("aria-label")).toBe(
      "Turn off camera",
    );
  });

  test("MIC_TOGGLE resolves exactly one toolbar button", () => {
    const nodes = doc.querySelectorAll(controlSelectors.MIC_TOGGLE);
    expect(nodes.length).toBe(1);
    expect((nodes[0] as HTMLElement).getAttribute("aria-label")).toBe(
      "Turn off microphone",
    );
  });

  test("LEAVE_BUTTON resolves the red hang-up button", () => {
    const nodes = doc.querySelectorAll(controlSelectors.LEAVE_BUTTON);
    expect(nodes.length).toBe(1);
    expect((nodes[0] as HTMLElement).textContent?.trim()).toBe("Leave call");
  });

  test("INGAME_READY_INDICATOR resolves in the ingame fixture", () => {
    // Fixture pin: the post-admission-only signal MUST be present in the
    // ingame fixture. If the ingame fixture is recaptured and this
    // selector ever stops matching, the join flow's step-5 wait will
    // time out after 90s on every real-world join — fail loud here so
    // the drift is caught during fixture refresh rather than in prod.
    //
    // The selector is an OR-list of the chat and participants panel
    // toggles, so both should be present in a real in-meeting capture.
    const nodes = doc.querySelectorAll(controlSelectors.INGAME_READY_INDICATOR);
    const labels = Array.from(nodes)
      .map((n) => (n as HTMLElement).getAttribute("aria-label"))
      .sort();
    expect(labels).toEqual(["Chat with everyone", "Show everyone"]);
  });

  test("INGAME_READY_INDICATOR does NOT resolve in the prejoin fixture", () => {
    // Fixture pin: the whole point of this selector is to be absent from
    // the waiting-room UI. If this ever matches the prejoin fixture, the
    // post-admission signal has been broken — the join flow would
    // short-circuit through step 5 before the host admits the bot,
    // re-introducing the original bug that INGAME_READY_INDICATOR exists
    // to fix.
    const prejoin = loadFixture("meet-dom-prejoin.html");
    const nodes = prejoin.querySelectorAll(
      controlSelectors.INGAME_READY_INDICATOR,
    );
    expect(nodes.length).toBe(0);
  });

  test("participant panel toggle resolves", () => {
    const nodes = doc.querySelectorAll(participantSelectors.PANEL_BUTTON);
    expect(nodes.length).toBe(1);
  });

  test("chat panel toggle resolves", () => {
    const nodes = doc.querySelectorAll(chatSelectors.PANEL_BUTTON);
    expect(nodes.length).toBe(1);
  });

  test("INGAME_ACTIVE_SPEAKER_INDICATOR only matches the speaking tile", () => {
    const nodes = doc.querySelectorAll(INGAME_ACTIVE_SPEAKER_INDICATOR);
    expect(nodes.length).toBe(1);
    expect((nodes[0] as HTMLElement).getAttribute("data-participant-id")).toBe(
      "p-alice",
    );
  });

  test("participant LIST resolves the side-panel list container", () => {
    const nodes = doc.querySelectorAll(participantSelectors.LIST);
    expect(nodes.length).toBe(1);
  });

  test("participant NODE resolves every participant row", () => {
    const list = doc.querySelector(participantSelectors.LIST);
    expect(list).not.toBeNull();
    const nodes = list?.querySelectorAll(participantSelectors.NODE) ?? [];
    expect(nodes.length).toBe(3);
  });

  test("participant NAME subselector resolves within each participant row", () => {
    const list = doc.querySelector(participantSelectors.LIST);
    const rows = list?.querySelectorAll(participantSelectors.NODE) ?? [];
    const names = Array.from(rows).map(
      (row) =>
        row.querySelector(participantSelectors.NAME)?.textContent?.trim() ??
        null,
    );
    expect(names).toEqual(["Alice", "Bob", "You"]);
  });

  test("presenter and speaking indicators only match the flagged row", () => {
    const presenters = doc.querySelectorAll(
      participantSelectors.PRESENTER_INDICATOR,
    );
    const speakers = doc.querySelectorAll(
      participantSelectors.SPEAKING_INDICATOR,
    );
    // Alice is the only presenter + speaker in the fixture; she appears in
    // both the grid tile and the participant-panel row for the speaking
    // indicator (data-active-speaker is a distinct attribute used by the
    // tile selector, so the panel-side speaking selector only matches the
    // participant row).
    expect(presenters.length).toBe(1);
    expect(speakers.length).toBe(1);
    expect(
      (presenters[0] as HTMLElement).getAttribute("data-participant-id"),
    ).toBe("p-alice");
    expect(
      (speakers[0] as HTMLElement).getAttribute("data-participant-id"),
    ).toBe("p-alice");
  });
});

describe("chat panel selectors", () => {
  const doc = loadFixture("meet-dom-chat.html");

  test("INPUT resolves the composer textarea (decorated aria-label)", () => {
    const nodes = doc.querySelectorAll(chatSelectors.INPUT);
    expect(nodes.length).toBe(1);
    expect((nodes[0] as HTMLTextAreaElement).tagName).toBe("TEXTAREA");
    // Fixture reflects the decorated form shipped by live Meet — the prefix
    // match must still resolve it.
    expect((nodes[0] as HTMLElement).getAttribute("aria-label")).toBe(
      "Send a message to everyone",
    );
  });

  test("INPUT prefix match resolves the bare aria-label variant too", () => {
    // Some Meet builds drop the "to everyone" decoration. Verify the same
    // selector matches the bare label — this is the forward/backward-compat
    // property the `^=` prefix match buys us.
    const bareHtml = `
      <div>
        <textarea aria-label="Send a message" rows="1"></textarea>
      </div>
    `;
    const bareDoc = new JSDOM(bareHtml).window.document;
    const nodes = bareDoc.querySelectorAll(chatSelectors.INPUT);
    expect(nodes.length).toBe(1);
    expect((nodes[0] as HTMLElement).tagName).toBe("TEXTAREA");
  });

  test("INPUT selector also matches contenteditable div composers", () => {
    // Meet has been migrating some surfaces from <textarea> to contenteditable
    // <div>. The selector admits both so future drift doesn't silently break
    // the query (the `chat.ts` typing logic is a separate concern — see the
    // selector comment and the PR body).
    const ceHtml = `
      <div>
        <div
          contenteditable="true"
          role="textbox"
          aria-label="Send a message to everyone"
        ></div>
      </div>
    `;
    const ceDoc = new JSDOM(ceHtml).window.document;
    const nodes = ceDoc.querySelectorAll(chatSelectors.INPUT);
    expect(nodes.length).toBe(1);
    expect((nodes[0] as HTMLElement).tagName).toBe("DIV");
    expect((nodes[0] as HTMLElement).getAttribute("contenteditable")).toBe(
      "true",
    );
  });

  test("INPUT selector resolves the inner editable child of a nested composer", () => {
    // Late-April-2026 live Meet renders the composer with the aria-label on a
    // wrapper and the contenteditable on a child. The third clause of INPUT
    // targets the inner editable so `.focus()` lands on the focusable node.
    const nestedHtml = `
      <div>
        <div aria-label="Send a message to everyone">
          <div contenteditable="true" role="textbox"></div>
        </div>
      </div>
    `;
    const nestedDoc = new JSDOM(nestedHtml).window.document;
    const nodes = nestedDoc.querySelectorAll(chatSelectors.INPUT);
    expect(nodes.length).toBe(1);
    const match = nodes[0] as HTMLElement;
    expect(match.tagName).toBe("DIV");
    expect(match.getAttribute("contenteditable")).toBe("true");
    // The inner child — not the aria-labelled wrapper — should be the match.
    expect(match.hasAttribute("aria-label")).toBe(false);
    expect(
      (match.parentElement as HTMLElement).getAttribute("aria-label"),
    ).toBe("Send a message to everyone");
  });

  test("SEND_BUTTON resolves the send button (decorated aria-label)", () => {
    const nodes = doc.querySelectorAll(chatSelectors.SEND_BUTTON);
    expect(nodes.length).toBe(1);
    expect((nodes[0] as HTMLElement).tagName).toBe("BUTTON");
    expect((nodes[0] as HTMLElement).getAttribute("aria-label")).toBe(
      "Send a message to everyone",
    );
  });

  test("SEND_BUTTON prefix match resolves the bare aria-label variant too", () => {
    const bareHtml = `
      <div>
        <button type="button" aria-label="Send a message">Send</button>
      </div>
    `;
    const bareDoc = new JSDOM(bareHtml).window.document;
    const nodes = bareDoc.querySelectorAll(chatSelectors.SEND_BUTTON);
    expect(nodes.length).toBe(1);
    expect((nodes[0] as HTMLElement).tagName).toBe("BUTTON");
  });

  test("MESSAGE_NODE resolves each rendered message", () => {
    const nodes = doc.querySelectorAll(chatSelectors.MESSAGE_NODE);
    expect(nodes.length).toBe(1);
    expect((nodes[0] as HTMLElement).getAttribute("data-message-id")).toBe(
      "msg-001",
    );
  });

  test("MESSAGE_SENDER/TEXT/TIMESTAMP subselectors extract message fields", () => {
    const message = doc.querySelector(chatSelectors.MESSAGE_NODE);
    expect(message).not.toBeNull();
    const sender = message?.querySelector(chatSelectors.MESSAGE_SENDER);
    const text = message?.querySelector(chatSelectors.MESSAGE_TEXT);
    const timestamp = message?.querySelector(chatSelectors.MESSAGE_TIMESTAMP);

    expect(sender?.textContent?.trim()).toBe("Alice");
    expect(text?.textContent?.trim()).toBe(
      "Hello everyone, welcome to the meeting.",
    );
    expect(
      (timestamp as HTMLTimeElement | null)?.getAttribute("datetime"),
    ).toBe("2026-04-15T12:34:00Z");
  });
});

describe("flat selectors aggregate", () => {
  test("exposes each named constant from the individual groups", () => {
    const cases: Array<[keyof typeof selectors, string]> = [
      ["PREJOIN_NAME_INPUT", prejoinSelectors.NAME_INPUT],
      [
        "PREJOIN_MEDIA_PROMPT_ACCEPT_BUTTON",
        prejoinSelectors.MEDIA_PROMPT_ACCEPT_BUTTON,
      ],
      ["PREJOIN_ASK_TO_JOIN_BUTTON", prejoinSelectors.ASK_TO_JOIN_BUTTON],
      ["PREJOIN_JOIN_NOW_BUTTON", prejoinSelectors.JOIN_NOW_BUTTON],
      ["INGAME_CHAT_PANEL_BUTTON", chatSelectors.PANEL_BUTTON],
      ["INGAME_CHAT_INPUT", chatSelectors.INPUT],
      ["INGAME_CHAT_SEND_BUTTON", chatSelectors.SEND_BUTTON],
      ["INGAME_CHAT_MESSAGE_NODE", chatSelectors.MESSAGE_NODE],
      ["INGAME_CHAT_MESSAGE_SENDER", chatSelectors.MESSAGE_SENDER],
      ["INGAME_CHAT_MESSAGE_TEXT", chatSelectors.MESSAGE_TEXT],
      ["INGAME_CHAT_MESSAGE_TIMESTAMP", chatSelectors.MESSAGE_TIMESTAMP],
      ["INGAME_PARTICIPANTS_PANEL_BUTTON", participantSelectors.PANEL_BUTTON],
      ["INGAME_PARTICIPANT_LIST", participantSelectors.LIST],
      ["INGAME_PARTICIPANT_NODE", participantSelectors.NODE],
      ["INGAME_PARTICIPANT_NAME", participantSelectors.NAME],
      [
        "INGAME_PARTICIPANT_PRESENTER_INDICATOR",
        participantSelectors.PRESENTER_INDICATOR,
      ],
      [
        "INGAME_PARTICIPANT_SPEAKING_INDICATOR",
        participantSelectors.SPEAKING_INDICATOR,
      ],
      ["INGAME_ACTIVE_SPEAKER_INDICATOR", INGAME_ACTIVE_SPEAKER_INDICATOR],
      ["INGAME_CAMERA_TOGGLE", controlSelectors.CAMERA_TOGGLE],
      ["INGAME_MIC_TOGGLE", controlSelectors.MIC_TOGGLE],
      ["INGAME_LEAVE_BUTTON", controlSelectors.LEAVE_BUTTON],
      ["INGAME_READY_INDICATOR", controlSelectors.INGAME_READY_INDICATOR],
    ];

    for (const [key, expected] of cases) {
      // Compare as plain strings — `selectors[key]` is typed with narrow
      // literal types via `as const`, so widen both sides to `string` before
      // asserting equality.
      expect(String(selectors[key])).toBe(expected);
    }
  });
});
