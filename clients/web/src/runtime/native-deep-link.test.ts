import { describe, expect, test } from "bun:test";

import {
  MAX_OPEN_THREAD_MESSAGE_LENGTH,
  MAX_START_VOICE_PROMPT_LENGTH,
  parseOpenThreadDeepLink,
  parseStartVoiceDeepLink,
} from "@/runtime/native-deep-link";

describe("parseStartVoiceDeepLink", () => {
  test("accepts every registered build-target scheme", () => {
    for (const scheme of [
      "vellum-assistant",
      "vellum-assistant-staging",
      "vellum-assistant-dev",
    ]) {
      expect(parseStartVoiceDeepLink(`${scheme}://voice?mode=new`)).toEqual({
        mode: "new",
        prompt: null,
        provenance: null,
      });
    }
  });

  test("parses mode=resume", () => {
    expect(
      parseStartVoiceDeepLink("vellum-assistant://voice?mode=resume"),
    ).toEqual({ mode: "resume", prompt: null, provenance: null });
  });

  test("defaults a missing mode to new — a bare link still means 'start talking'", () => {
    expect(parseStartVoiceDeepLink("vellum-assistant://voice")).toEqual({
      mode: "new",
      prompt: null,
      provenance: null,
    });
  });

  test("defaults an unrecognized mode to new", () => {
    expect(
      parseStartVoiceDeepLink("vellum-assistant://voice?mode=teleport"),
    ).toEqual({ mode: "new", prompt: null, provenance: null });
  });

  test("rejects look-alike schemes — a prefix match would let a hostile app in", () => {
    expect(
      parseStartVoiceDeepLink("vellum-assistant-evil://voice?mode=new"),
    ).toBeNull();
    expect(parseStartVoiceDeepLink("vellum://voice?mode=new")).toBeNull();
    expect(parseStartVoiceDeepLink("https://voice?mode=new")).toBeNull();
  });

  test("rejects other hosts on a valid scheme", () => {
    expect(
      parseStartVoiceDeepLink("vellum-assistant://oauth-complete"),
    ).toBeNull();
    expect(
      parseStartVoiceDeepLink("vellum-assistant://voices?mode=new"),
    ).toBeNull();
    expect(
      parseStartVoiceDeepLink("vellum-assistant://billing/voice"),
    ).toBeNull();
  });

  test("rejects unparseable URLs", () => {
    expect(parseStartVoiceDeepLink("::not-a-url")).toBeNull();
    expect(parseStartVoiceDeepLink("")).toBeNull();
  });
});

/**
 * Build the link exactly the way `VoiceModeDeepLink.url(prompt:)` does on the
 * Swift side: every reserved character percent-encoded, so the query has one
 * unambiguous parse. `encodeURIComponent` and Swift's
 * `addingPercentEncoding(withAllowedCharacters:)` over the same reduced set
 * agree on every character these tests exercise.
 */
function askLink(prompt: string, mode = "new"): string {
  return `vellum-assistant://voice?mode=${mode}&prompt=${encodeURIComponent(prompt)}`;
}

describe("parseStartVoiceDeepLink - prompt", () => {
  test("a link with no prompt is identical to a plain mode=new link", () => {
    expect(
      parseStartVoiceDeepLink("vellum-assistant://voice?mode=new"),
    ).toEqual(parseStartVoiceDeepLink("vellum-assistant://voice"));
    expect(
      parseStartVoiceDeepLink("vellum-assistant://voice?mode=new")?.prompt,
    ).toBeNull();
  });

  test("round-trips the characters that would otherwise break the query", () => {
    // `&` and `=` would split the query into extra parameters, `?` and `#`
    // would read as delimiters, and a bare `+` decodes to a space under
    // `URLSearchParams`. All of them are why the Swift producer percent-encodes
    // rather than handing `URLComponents` a raw value.
    for (const spoken of [
      "what's on my calendar?",
      "compare Ben & Jerry's vs Haagen-Dazs",
      "search for #standup notes",
      "what is 2 + 2 = ?",
      "remind me at 100% capacity",
    ]) {
      expect(parseStartVoiceDeepLink(askLink(spoken))?.prompt).toBe(spoken);
    }
  });

  test("round-trips emoji and other non-ASCII intact", () => {
    for (const spoken of [
      "book a table \u{1F35C} for two",
      "¿cuál es el plan de mañana?",
      "翻译这句话",
    ]) {
      expect(parseStartVoiceDeepLink(askLink(spoken))?.prompt).toBe(spoken);
    }
  });

  test("trims surrounding whitespace and drops a whitespace-only prompt", () => {
    expect(parseStartVoiceDeepLink(askLink("  hello there  "))?.prompt).toBe(
      "hello there",
    );
    expect(parseStartVoiceDeepLink(askLink("   "))?.prompt).toBeNull();
    expect(parseStartVoiceDeepLink(askLink(""))?.prompt).toBeNull();
  });

  test("accepts a prompt exactly at the cap and rejects one character more", () => {
    const atCap = "a".repeat(MAX_START_VOICE_PROMPT_LENGTH);
    expect(parseStartVoiceDeepLink(askLink(atCap))?.prompt).toBe(atCap);
    expect(parseStartVoiceDeepLink(askLink(`${atCap}a`))?.prompt).toBeNull();
  });

  test("drops an over-length prompt whole rather than truncating it", () => {
    const tooLong = "a".repeat(MAX_START_VOICE_PROMPT_LENGTH + 500);
    // Half a question is a different question - the link still starts a
    // session, it just carries no text.
    expect(parseStartVoiceDeepLink(askLink(tooLong))).toEqual({
      mode: "new",
      prompt: null,
      provenance: null,
    });
  });

  test("rejects control characters - C0, DEL, C1, and the line separators", () => {
    for (const control of [
      "\u0000",
      "\u0009",
      "\u000a",
      "\u000d",
      "\u001f",
      "\u007f",
      "\u0085",
      "\u009f",
      "\u2028",
      "\u2029",
    ]) {
      expect(
        parseStartVoiceDeepLink(askLink(`hello${control}world`))?.prompt,
      ).toBeNull();
    }
  });

  test("a rejected prompt still yields a usable voice command", () => {
    // The user did ask for voice; only the text is untrustworthy.
    expect(parseStartVoiceDeepLink(askLink("bad\u0000text", "resume"))).toEqual(
      { mode: "resume", prompt: null, provenance: null },
    );
  });

  test("still rejects the link itself for a bad scheme or host, prompt or not", () => {
    expect(
      parseStartVoiceDeepLink(
        "vellum-assistant-evil://voice?mode=new&prompt=hi",
      ),
    ).toBeNull();
    expect(
      parseStartVoiceDeepLink("vellum-assistant://voices?mode=new&prompt=hi"),
    ).toBeNull();
  });

  test("decodes the exact URLs the Swift producer emits", () => {
    // Captured from `VoiceModeDeepLink.url(prompt:)` rather than rebuilt here,
    // so a change to either side's escaping rules fails this test instead of
    // silently agreeing with itself. Note `'` arrives unescaped and `+`, `&`,
    // `?`, `#`, `%` arrive escaped - that split is the contract.
    const cases: Array<[string, string]> = [
      [
        "vellum-assistant://voice?mode=new&prompt=what's%20on%20my%20calendar%3F",
        "what's on my calendar?",
      ],
      [
        "vellum-assistant://voice?mode=new&prompt=Ben%20%26%20Jerry's%20vs%20Haagen-Dazs",
        "Ben & Jerry's vs Haagen-Dazs",
      ],
      [
        "vellum-assistant://voice?mode=new&prompt=search%20for%20%23standup%20notes",
        "search for #standup notes",
      ],
      [
        "vellum-assistant://voice?mode=new&prompt=what%20is%202%20%2B%202%20%3D%20%3F",
        "what is 2 + 2 = ?",
      ],
      [
        "vellum-assistant://voice?mode=new&prompt=book%20a%20table%20%F0%9F%8D%9C%20for%20two",
        "book a table \u{1F35C} for two",
      ],
      [
        "vellum-assistant://voice?mode=new&prompt=100%25%20capacity",
        "100% capacity",
      ],
    ];
    for (const [link, expected] of cases) {
      expect(parseStartVoiceDeepLink(link)).toEqual({
        mode: "new",
        prompt: expected,
        provenance: null,
      });
    }
  });
});

/**
 * Build the link exactly the way `ThreadDeepLink.url(message:)` does on the
 * Swift side, with the same encoding agreement `askLink` documents above.
 */
function threadLink(threadId: string, message?: string): string {
  const base = `vellum-assistant://thread/${threadId}`;
  return message === undefined
    ? base
    : `${base}?message=${encodeURIComponent(message)}`;
}

describe("parseOpenThreadDeepLink", () => {
  const THREAD_ID = "0198f2f7-6c4e-7a31-b552-9c4d1a2b3c4d";

  test("accepts every registered build-target scheme", () => {
    for (const scheme of [
      "vellum-assistant",
      "vellum-assistant-staging",
      "vellum-assistant-dev",
    ]) {
      expect(
        parseOpenThreadDeepLink(`${scheme}://thread/${THREAD_ID}`),
      ).toEqual({ threadId: THREAD_ID, message: null, provenance: null });
    }
  });

  test("rejects look-alike schemes - a prefix match would let a hostile app in", () => {
    expect(
      parseOpenThreadDeepLink(`vellum-assistant-evil://thread/${THREAD_ID}`),
    ).toBeNull();
    expect(parseOpenThreadDeepLink(`vellum://thread/${THREAD_ID}`)).toBeNull();
    expect(parseOpenThreadDeepLink(`https://thread/${THREAD_ID}`)).toBeNull();
  });

  test("rejects other hosts on a valid scheme", () => {
    expect(
      parseOpenThreadDeepLink(`vellum-assistant://threads/${THREAD_ID}`),
    ).toBeNull();
    expect(
      parseOpenThreadDeepLink(`vellum-assistant://voice/${THREAD_ID}`),
    ).toBeNull();
  });

  test("rejects a missing, multi-segment, or malformed id", () => {
    expect(parseOpenThreadDeepLink("vellum-assistant://thread")).toBeNull();
    expect(parseOpenThreadDeepLink("vellum-assistant://thread/")).toBeNull();
    expect(
      parseOpenThreadDeepLink(`vellum-assistant://thread/${THREAD_ID}/extra`),
    ).toBeNull();
    // Percent-encoding in the id is structure-smuggling, not an id.
    expect(
      parseOpenThreadDeepLink("vellum-assistant://thread/abc%2Fdef"),
    ).toBeNull();
    expect(
      parseOpenThreadDeepLink(`vellum-assistant://thread/${"a".repeat(129)}`),
    ).toBeNull();
  });

  test("accepts an id exactly at the length cap", () => {
    const atCap = "a".repeat(128);
    expect(
      parseOpenThreadDeepLink(`vellum-assistant://thread/${atCap}`),
    ).toEqual({ threadId: atCap, message: null, provenance: null });
  });

  test("round-trips a message with query-breaking characters", () => {
    for (const message of [
      "log: gym done & stretching",
      "what is 2 + 2 = ?",
      "ship it #now, at 100%",
    ]) {
      expect(
        parseOpenThreadDeepLink(threadLink(THREAD_ID, message))?.message,
      ).toBe(message);
    }
  });

  test("keeps typed line breaks, normalizing CRLF and lone CR to LF", () => {
    expect(
      parseOpenThreadDeepLink(threadLink(THREAD_ID, "log:\n- gym\n- stretch"))
        ?.message,
    ).toBe("log:\n- gym\n- stretch");
    expect(
      parseOpenThreadDeepLink(threadLink(THREAD_ID, "one\r\ntwo\rthree"))
        ?.message,
    ).toBe("one\ntwo\nthree");
  });

  test("still rejects the other control characters a hand-built link could carry", () => {
    for (const control of ["\u0000", "\u000b", "\u001f", "\u007f", "\u2028"]) {
      expect(
        parseOpenThreadDeepLink(threadLink(THREAD_ID, `one${control}two`)),
      ).toEqual({ threadId: THREAD_ID, message: null, provenance: null });
    }
  });

  test("degrades a rejected message to a message-less open rather than dropping the link", () => {
    const tooLong = "a".repeat(MAX_OPEN_THREAD_MESSAGE_LENGTH + 1);
    for (const link of [
      threadLink(THREAD_ID, tooLong),
      threadLink(THREAD_ID, "   "),
      threadLink(THREAD_ID, ""),
    ]) {
      expect(parseOpenThreadDeepLink(link)).toEqual({
        threadId: THREAD_ID,
        message: null,
        provenance: null,
      });
    }
  });

  test("accepts a message exactly at the cap and rejects one character more", () => {
    const atCap = "b".repeat(MAX_OPEN_THREAD_MESSAGE_LENGTH);
    expect(parseOpenThreadDeepLink(threadLink(THREAD_ID, atCap))?.message).toBe(
      atCap,
    );
    expect(
      parseOpenThreadDeepLink(threadLink(THREAD_ID, `${atCap}b`))?.message,
    ).toBeNull();
  });

  test("rejects unparseable URLs", () => {
    expect(parseOpenThreadDeepLink("::not-a-url")).toBeNull();
    expect(parseOpenThreadDeepLink("")).toBeNull();
  });
});

describe("command URL provenance", () => {
  const THREAD_ID = "0198f2f7-6c4e-7a31-b552-9c4d1a2b3c4d";
  const voiceIntent = "vellum-assistant://voice?mode=new&prompt=hi&src=intent";
  const threadIntent = `vellum-assistant://thread/${THREAD_ID}?message=hi&src=intent`;

  test("is null by default even when the marker is present: trust is opt-in", () => {
    // A caller that has not said its shell strips the marker at external
    // entry points must not be able to trust it by omission.
    expect(parseStartVoiceDeepLink(voiceIntent)?.provenance).toBeNull();
    expect(parseOpenThreadDeepLink(threadIntent)?.provenance).toBeNull();
    expect(
      parseStartVoiceDeepLink(voiceIntent, { acceptProvenance: false })
        ?.provenance,
    ).toBeNull();
  });

  test("is 'intent' only for the exact marker when the caller opts in", () => {
    const opts = { acceptProvenance: true };
    expect(parseStartVoiceDeepLink(voiceIntent, opts)?.provenance).toBe(
      "intent",
    );
    expect(parseOpenThreadDeepLink(threadIntent, opts)?.provenance).toBe(
      "intent",
    );
    // Absent, or any other value, is unknown origin.
    expect(
      parseStartVoiceDeepLink("vellum-assistant://voice?prompt=hi", opts)
        ?.provenance,
    ).toBeNull();
    expect(
      parseStartVoiceDeepLink(
        "vellum-assistant://voice?prompt=hi&src=shortcut",
        opts,
      )?.provenance,
    ).toBeNull();
    expect(
      parseOpenThreadDeepLink(
        `vellum-assistant://thread/${THREAD_ID}?src=INTENT`,
        opts,
      )?.provenance,
    ).toBeNull();
  });

  test("honors only the raw `src=intent` item, never a percent-encoded spelling", () => {
    // `URLSearchParams` decodes each of these to `src` / `intent`; the shell
    // and this parser are different URL parsers over the same string, so the
    // only spelling this side may honor is the raw item both see identically
    // (ATL-1293).
    const opts = { acceptProvenance: true };
    const encodedSpellings = [
      "vellum-assistant://voice?s%72c=intent&prompt=hi",
      "vellum-assistant://voice?%73%72%63=intent&prompt=hi",
      "vellum-assistant://voice?%FF=1&s%72c=intent&prompt=hi",
      "vellum-assistant://voice?src=%69ntent&prompt=hi",
    ];
    for (const link of encodedSpellings) {
      expect(parseStartVoiceDeepLink(link, opts)?.provenance).toBeNull();
    }
    expect(
      parseOpenThreadDeepLink(
        `vellum-assistant://thread/${THREAD_ID}?message=hi&s%72c=intent`,
        opts,
      )?.provenance,
    ).toBeNull();
    // Position and neighbours do not matter, only the item itself.
    expect(
      parseStartVoiceDeepLink(
        "vellum-assistant://voice?src=intent&prompt=hi&&mode=new&",
        opts,
      )?.provenance,
    ).toBe("intent");
    expect(
      parseStartVoiceDeepLink("vellum-assistant://voice?src=intent#frag", opts)
        ?.provenance,
    ).toBe("intent");
  });

  test("the marker never rescues a link the parser would otherwise reject", () => {
    const opts = { acceptProvenance: true };
    expect(
      parseStartVoiceDeepLink("vellum-assistant-evil://voice?src=intent", opts),
    ).toBeNull();
    expect(
      parseOpenThreadDeepLink("vellum-assistant://thread/?src=intent", opts),
    ).toBeNull();
    // Text sanitization is independent of provenance: a proven link with an
    // unusable message still parses, message-less.
    const tooLong = "a".repeat(MAX_OPEN_THREAD_MESSAGE_LENGTH + 1);
    expect(
      parseOpenThreadDeepLink(
        `${threadLink(THREAD_ID, tooLong)}&src=intent`,
        opts,
      ),
    ).toEqual({ threadId: THREAD_ID, message: null, provenance: "intent" });
  });
});
