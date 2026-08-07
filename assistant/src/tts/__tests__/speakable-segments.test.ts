import { describe, expect, test } from "bun:test";

import { sanitizeForTts } from "../../calls/tts-text-sanitizer.js";
import { extractSpeakableSegments } from "../speakable-segments.js";

const DEFAULT_CHAR_THRESHOLD = 180;
const EAGER_CHAR_THRESHOLD = 60;

// The compile target's lib predates String.prototype.isWellFormed; Bun
// supports it at runtime.
function isWellFormedUtf16(value: string): boolean {
  return (value as string & { isWellFormed(): boolean }).isWellFormed();
}

describe("extractSpeakableSegments", () => {
  test("splits complete sentences and keeps the trailing fragment as remainder", () => {
    const { segments, remainder } = extractSpeakableSegments(
      "Hello there. How are you? Still typ",
      false,
    );

    expect(segments).toEqual(["Hello there.", "How are you?"]);
    expect(remainder).toBe(" Still typ");
  });

  test("includes trailing quotes and brackets in the sentence segment", () => {
    const { segments, remainder } = extractSpeakableSegments(
      'She said "stop!") And then',
      false,
    );

    expect(segments).toEqual(['She said "stop!")']);
    expect(remainder).toBe(" And then");
  });

  test("does not split at punctuation followed by non-whitespace", () => {
    const { segments, remainder } = extractSpeakableSegments(
      "Version 3.5 is out",
      false,
    );

    expect(segments).toEqual([]);
    expect(remainder).toBe("Version 3.5 is out");
  });

  test("does not split inside a decimal number", () => {
    const { segments, remainder } = extractSpeakableSegments(
      "3.14 is pi.",
      false,
    );

    expect(segments).toEqual(["3.14 is pi."]);
    expect(remainder).toBe("");
  });

  test("treats a newline as a segment boundary", () => {
    const { segments, remainder } = extractSpeakableSegments(
      "First line\nsecond line still going",
      false,
    );

    expect(segments).toEqual(["First line"]);
    expect(remainder).toBe("second line still going");
  });

  test("returns punctuation at end-of-text as a complete segment", () => {
    const { segments, remainder } = extractSpeakableSegments(
      "All done here.",
      false,
    );

    expect(segments).toEqual(["All done here."]);
    expect(remainder).toBe("");
  });

  test("sub-threshold text without a boundary yields no segments until forced", () => {
    const text = "still waiting for a sentence to finish";

    const unforced = extractSpeakableSegments(text, false);
    expect(unforced.segments).toEqual([]);
    expect(unforced.remainder).toBe(text);

    const forced = extractSpeakableSegments(text, true);
    expect(forced.segments).toEqual([text]);
    expect(forced.remainder).toBe("");
  });

  test("force skips whitespace-only remainders", () => {
    const { segments, remainder } = extractSpeakableSegments("   ", true);

    expect(segments).toEqual([]);
    expect(remainder).toBe("");
  });

  test("text below the 180-char threshold does not force-split", () => {
    const text = "y".repeat(DEFAULT_CHAR_THRESHOLD - 1);

    const { segments, remainder } = extractSpeakableSegments(text, false);

    expect(segments).toEqual([]);
    expect(remainder).toBe(text);
  });

  test("over-threshold text splits at the last whitespace before the threshold", () => {
    const text = "steady ".repeat(40);

    const { segments, remainder } = extractSpeakableSegments(text, false);

    expect(segments).toHaveLength(1);
    const segment = segments[0] ?? "";
    expect(segment.length).toBeLessThanOrEqual(DEFAULT_CHAR_THRESHOLD);
    expect(segment.endsWith("steady")).toBe(true);
    expect(remainder.startsWith("steady")).toBe(true);
    // No text is lost across the split.
    expect(`${segment} ${remainder}`).toBe(text);
  });

  test("over-threshold text without whitespace splits at the threshold exactly", () => {
    const text = "x".repeat(DEFAULT_CHAR_THRESHOLD + 20);

    const { segments, remainder } = extractSpeakableSegments(text, false);

    expect(segments).toEqual(["x".repeat(DEFAULT_CHAR_THRESHOLD)]);
    expect(remainder).toBe("x".repeat(20));
  });

  describe("eager mode", () => {
    test("splits at a comma once enough text precedes it", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "Sure, I can help with that, and here is more",
        false,
        { eager: true },
      );

      expect(segments).toEqual(["Sure, I can help with that,"]);
      expect(remainder).toBe(" and here is more");
    });

    test("splits at semicolons and colons past the prefix floor", () => {
      const { segments } = extractSpeakableSegments(
        "Here is what I found today; there is more coming",
        false,
        { eager: true },
      );

      expect(segments).toEqual(["Here is what I found today;"]);
    });

    test("a short clause like 'Sure, ' does not flush on its own", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "Sure, ",
        false,
        { eager: true },
      );

      expect(segments).toEqual([]);
      expect(remainder).toBe("Sure, ");
    });

    test("clause punctuation at end-of-text keeps buffering", () => {
      const text = "Sure, I can help with that,";

      const { segments, remainder } = extractSpeakableSegments(text, false, {
        eager: true,
      });

      expect(segments).toEqual([]);
      expect(remainder).toBe(text);
    });

    test("uses the lower 60-char threshold to split without punctuation", () => {
      const text = "word ".repeat(20);

      const { segments } = extractSpeakableSegments(text, false, {
        eager: true,
      });

      expect(segments.length).toBeGreaterThan(0);
      const segment = segments[0] ?? "";
      expect(segment.length).toBeLessThanOrEqual(EAGER_CHAR_THRESHOLD);
      expect(segment.endsWith("word")).toBe(true);
    });

    test("eagerness applies only to the first segment of a call", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "Sure, I can help with that, and after that we can keep going, with more",
        false,
        { eager: true },
      );

      expect(segments).toEqual(["Sure, I can help with that,"]);
      expect(remainder).toBe(" and after that we can keep going, with more");
    });

    test("non-eager extraction ignores clause punctuation", () => {
      const text = "Sure, I can help with that, and here is more";

      const { segments, remainder } = extractSpeakableSegments(text, false);

      expect(segments).toEqual([]);
      expect(remainder).toBe(text);
    });
  });

  describe("non-Latin scripts", () => {
    test("splits Hindi at the danda", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "नमस्ते। आप कैसे हैं?",
        false,
      );

      expect(segments).toEqual(["नमस्ते।", "आप कैसे हैं?"]);
      expect(remainder).toBe("");
    });

    test("splits Japanese at the ideographic full stop with no whitespace", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "こんにちは。今日はいい天気ですね。続き",
        false,
      );

      expect(segments).toEqual(["こんにちは。", "今日はいい天気ですね。"]);
      expect(remainder).toBe("続き");
    });

    test("a buffer ending at a non-Latin ender keeps buffering for closers", () => {
      // Streaming deltas can split a quoted sentence: `「こんにちは。`
      // arrives first and `」次です。` in the next delta. A boundary at the
      // buffer-final 。 would orphan the 」 into the next segment.
      const firstDelta = extractSpeakableSegments("「こんにちは。", false);
      expect(firstDelta.segments).toEqual([]);
      expect(firstDelta.remainder).toBe("「こんにちは。");

      const afterNextDelta = extractSpeakableSegments(
        `${firstDelta.remainder}」次です。`,
        false,
      );
      expect(afterNextDelta.segments).toEqual(["「こんにちは。」"]);
      expect(afterNextDelta.remainder).toBe("次です。");
    });

    test("force still flushes a buffer ending at an ideographic full stop", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "終わりです。",
        true,
      );

      expect(segments).toEqual(["終わりです。"]);
      expect(remainder).toBe("");
    });

    test("the Arabic question mark terminates a segment", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "كيف حالك؟ الطقس جميل",
        false,
      );

      expect(segments).toEqual(["كيف حالك؟"]);
      expect(remainder).toBe(" الطقس جميل");
    });

    test("eager mode splits at an ideographic comma with no whitespace", () => {
      const text = `${"あ".repeat(30)}、まだ続く`;

      const { segments, remainder } = extractSpeakableSegments(text, false, {
        eager: true,
      });

      expect(segments).toEqual([`${"あ".repeat(30)}、`]);
      expect(remainder).toBe("まだ続く");
    });

    test("eager mode keeps a fullwidth grouping comma inside a number", () => {
      const text =
        "これは長い導入文で二十四文字を確実に超えています１，０００円です";

      const { segments, remainder } = extractSpeakableSegments(text, false, {
        eager: true,
      });

      expect(segments).toEqual([]);
      expect(remainder).toBe(text);
    });

    test("eager mode defers a digit-final fullwidth comma at the buffer edge", () => {
      // The grouped digits may arrive in the next delta (`１，` then
      // `０００円`), so a buffer-final comma after a digit keeps buffering.
      const text = "これは長い導入文で二十四文字を確実に超えています１，";

      const { segments, remainder } = extractSpeakableSegments(text, false, {
        eager: true,
      });

      expect(segments).toEqual([]);
      expect(remainder).toBe(text);
    });

    test("eager mode still splits at a fullwidth comma between non-digits", () => {
      const text = `${"あ".repeat(30)}，まだ続く`;

      const { segments, remainder } = extractSpeakableSegments(text, false, {
        eager: true,
      });

      expect(segments).toEqual([`${"あ".repeat(30)}，`]);
      expect(remainder).toBe("まだ続く");
    });

    test("hard-cap splits never break a surrogate pair", () => {
      // "犬" shifts every non-BMP pair to an odd offset so the 180-unit cap
      // lands mid-pair without the step-back.
      const text = `犬${"𠮟".repeat(120)}`;

      const { segments, remainder } = extractSpeakableSegments(text, false);

      expect(segments).toHaveLength(1);
      for (const segment of segments) {
        expect(isWellFormedUtf16(segment)).toBe(true);
      }
      expect(isWellFormedUtf16(remainder)).toBe(true);
      // No text is lost or reordered across the split.
      expect(segments.join("") + remainder).toBe(text);
    });

    test("accented italic spans toggle like ASCII ones", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "*café. crème* done. And more",
        false,
      );

      expect(segments).toEqual(["*café. crème* done."]);
      expect(remainder).toBe(" And more");
    });

    test("CJK underscore spans toggle like ASCII ones", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "_変数_ です。まだ続きます",
        false,
      );

      expect(segments).toEqual(["_変数_ です。"]);
      expect(remainder).toBe("まだ続きます");
    });

    test("does not split a fullwidth decimal number", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "３．１４です",
        false,
      );

      expect(segments).toEqual([]);
      expect(remainder).toBe("３．１４です");
    });

    test("a buffer ending exactly at a fullwidth full stop keeps buffering", () => {
      // Streaming deltas can split a fullwidth decimal: `３．` arrives
      // first and `１４です` in the next delta. The trailing ．must not be
      // classified as a sentence boundary until the next character shows
      // whether it is a decimal point.
      const firstDelta = extractSpeakableSegments("３．", false);
      expect(firstDelta.segments).toEqual([]);
      expect(firstDelta.remainder).toBe("３．");

      const afterNextDelta = extractSpeakableSegments(
        `${firstDelta.remainder}１４です。次`,
        false,
      );
      expect(afterNextDelta.segments).toEqual(["３．１４です。"]);
      expect(afterNextDelta.remainder).toBe("次");
    });

    test("force still flushes a buffer ending at a fullwidth full stop", () => {
      const { segments, remainder } = extractSpeakableSegments("３．", true);

      expect(segments).toEqual(["３．"]);
      expect(remainder).toBe("");
    });

    test("the fullwidth full stop still ends a genuine sentence", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "終わりです．次です",
        false,
      );

      expect(segments).toEqual(["終わりです．"]);
      expect(remainder).toBe("次です");
    });

    test("the halfwidth ideographic full stop ends a sentence", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "こんにちは｡次です",
        false,
      );

      expect(segments).toEqual(["こんにちは｡"]);
      expect(remainder).toBe("次です");
    });

    test("non-Latin enders inside a Markdown link URL do not split", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "[記事](https://example.com/前編。後編)を読んで。次",
        false,
      );

      expect(segments).toEqual([
        "[記事](https://example.com/前編。後編)を読んで。",
      ]);
      expect(remainder).toBe("次");
    });

    test("an unclosed link URL still splits at a newline", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "[x](https://a。b\n次",
        false,
      );

      expect(segments).toEqual(["[x](https://a。b"]);
      expect(remainder).toBe("次");
    });

    test("balanced parens inside a link URL keep suppressing boundaries", () => {
      // The sanitizer's link pattern accepts balanced parens inside URLs
      // (Wikipedia-style paths), so the segmenter must not exit the URL at
      // the inner closing paren and split at a later terminator.
      const { segments, remainder } = extractSpeakableSegments(
        "[記事](https://example.com/a_(b)/前編。後編)を読んで。次",
        false,
      );

      expect(segments).toEqual([
        "[記事](https://example.com/a_(b)/前編。後編)を読んで。",
      ]);
      expect(remainder).toBe("次");
    });

    test("non-Latin enders inside a Markdown link label do not split the link", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "[詳細。こちら](https://example.com)を確認。次",
        false,
      );

      expect(segments).toEqual(["[詳細。こちら](https://example.com)を確認。"]);
      expect(remainder).toBe("次");
      // The intact link sanitizes to its label; a split would have left
      // markup or the raw URL in a fragment.
      expect(sanitizeForTts(segments[0] ?? "")).toBe("詳細。こちらを確認。");
    });

    test("enders inside image alt text do not split the image link", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "![代替。テキスト](https://example.com/a.png)です。次",
        false,
      );

      expect(segments).toEqual([
        "![代替。テキスト](https://example.com/a.png)です。",
      ]);
      expect(remainder).toBe("次");
    });

    test("a bracket inside an inline code span does not suppress the sentence boundary", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "Use `const items = [` to start. Then close it later on.",
        false,
      );

      expect(segments).toEqual([
        "Use `const items = [` to start.",
        "Then close it later on.",
      ]);
      expect(remainder).toBe("");
    });

    test("a stray bracket splits at the suppressed boundary once a newline cancels it", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "これは[メモ。次です。\nそして",
        false,
      );

      expect(segments).toEqual(["これは[メモ。", "次です。"]);
      expect(remainder).toBe("そして");
    });

    test("a closing bracket without a paren reopens the suppressed boundary", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "これは[メモ。です]ね。次",
        false,
      );

      expect(segments).toEqual(["これは[メモ。", "です]ね。"]);
      expect(remainder).toBe("次");
    });

    test("a stray bracket in a long buffer splits at the suppressed boundary at the cap", () => {
      const filler = "あ".repeat(DEFAULT_CHAR_THRESHOLD);
      const { segments, remainder } = extractSpeakableSegments(
        `これは[メモ。${filler}`,
        false,
      );

      expect(segments).toEqual(["これは[メモ。", filler]);
      expect(remainder).toBe("");
    });

    test("a label split across deltas defers, then completes", () => {
      const firstDelta = extractSpeakableSegments("[詳細。こち", false);
      expect(firstDelta.segments).toEqual([]);
      expect(firstDelta.remainder).toBe("[詳細。こち");

      const afterNextDelta = extractSpeakableSegments(
        `${firstDelta.remainder}ら](https://example.com)を確認。次`,
        false,
      );
      expect(afterNextDelta.segments).toEqual([
        "[詳細。こちら](https://example.com)を確認。",
      ]);
      expect(afterNextDelta.remainder).toBe("次");
    });

    test("a buffer-final closing bracket keeps buffering for the paren", () => {
      const firstDelta = extractSpeakableSegments("[詳細。こちら]", false);
      expect(firstDelta.segments).toEqual([]);
      expect(firstDelta.remainder).toBe("[詳細。こちら]");

      const afterNextDelta = extractSpeakableSegments(
        `${firstDelta.remainder}(https://example.com)を確認。次`,
        false,
      );
      expect(afterNextDelta.segments).toEqual([
        "[詳細。こちら](https://example.com)を確認。",
      ]);
      expect(afterNextDelta.remainder).toBe("次");
    });

    test("force flushes a buffer-final open label", () => {
      const openLabel = extractSpeakableSegments("[詳細。こち", true);
      expect(openLabel.segments).toEqual(["[詳細。こち"]);
      expect(openLabel.remainder).toBe("");

      const openUrl = extractSpeakableSegments(
        "[詳細。こちら](https://exa",
        true,
      );
      expect(openUrl.segments).toEqual(["[詳細。こちら](https://exa"]);
      expect(openUrl.remainder).toBe("");
    });

    test("adjacent enders stay in one segment", () => {
      // 本当！？ must not emit 本当！ and then a punctuation-only ？ segment.
      const { segments, remainder } = extractSpeakableSegments(
        "本当！？次です",
        false,
      );

      expect(segments).toEqual(["本当！？"]);
      expect(remainder).toBe("次です");
    });

    test("adjacent enders followed by a closer stay together", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "「本当！？」次です",
        false,
      );

      expect(segments).toEqual(["「本当！？」"]);
      expect(remainder).toBe("次です");
    });

    test("a fullwidth stop inside a filename-style token does not split", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "添付のreport．pdfを見てください。次です",
        false,
      );

      expect(segments).toEqual(["添付のreport．pdfを見てください。"]);
      expect(remainder).toBe("次です");
    });

    test("keeps a CJK closing bracket with its sentence", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "「こんにちは。」次です。",
        false,
      );

      expect(segments).toEqual(["「こんにちは。」"]);
      // The trailing sentence ends at the buffer edge, so it keeps
      // buffering in case the next delta opens with a closer.
      expect(remainder).toBe("次です。");
    });

    test("keeps a CJK double angle bracket with its sentence", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "《こんにちは。》次です。",
        false,
      );

      expect(segments).toEqual(["《こんにちは。》"]);
      expect(remainder).toBe("次です。");
    });

    test("keeps a closing curly quote with its sentence", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "“早く！”と言った。まだ続く",
        false,
      );

      expect(segments).toEqual(["“早く！”", "と言った。"]);
      expect(remainder).toBe("まだ続く");
    });

    test("a span closer touching an astral word char keeps the span open", () => {
      // 𠮟 is a non-BMP letter (surrogate pair). The sanitizer's Unicode
      // lookarounds see it as \p{L} and leave *note*𠮟 unstripped, so the
      // segmenter must agree and defer the boundary at the period.
      const text = "*note*𠮟. Next";

      const { segments, remainder } = extractSpeakableSegments(text, false);

      expect(segments).toEqual([]);
      expect(remainder).toBe(text);

      // Forced flush keeps the whole span in one segment, so per-segment
      // sanitization matches whole-text sanitization: no unbalanced marker
      // is spoken.
      const forced = extractSpeakableSegments(text, true);
      expect(forced.segments.map(sanitizeForTts).join("")).toBe(
        sanitizeForTts(text),
      );
    });

    test("astral underscore spans toggle like BMP ones", () => {
      // prev/next of both `_` markers are surrogate-pair halves; assembled
      // code points make the span open and close exactly as the sanitizer's
      // lookarounds do, so the split after 。 leaks no markers.
      const { segments, remainder } = extractSpeakableSegments(
        "_𠮟_ です。まだ続く",
        false,
      );

      expect(segments).toEqual(["_𠮟_ です。"]);
      expect(remainder).toBe("まだ続く");
      // The sanitizer strips the balanced span, so nothing leaks.
      expect(sanitizeForTts(segments[0] ?? "")).toBe("𠮟 です。");
    });

    test("a span closer touching a CJK word char keeps the span open", () => {
      // Mirrors the sanitizer's Unicode lookarounds: it leaves *強調*です
      // unstripped, so splitting after the 。 would leak the markers.
      const text = "*強調*です。まだ続く";

      const { segments, remainder } = extractSpeakableSegments(text, false);

      expect(segments).toEqual([]);
      expect(remainder).toBe(text);
    });
  });

  describe("open inline spans", () => {
    test("does not split at a clause boundary inside an open bold span", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "**bold text that keeps going, more** and then.",
        false,
        { eager: true },
      );

      expect(segments).toEqual([
        "**bold text that keeps going, more** and then.",
      ]);
      expect(remainder).toBe("");
    });

    test("does not split at a clause boundary inside an open backtick span", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "`code segment with a comma here, x` done.",
        false,
        { eager: true },
      );

      expect(segments).toEqual(["`code segment with a comma here, x` done."]);
      expect(remainder).toBe("");
    });

    test("splits normally at a clause boundary after a balanced span", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "He said **wait** and more, then it continued on",
        false,
        { eager: true },
      );

      expect(segments).toEqual(["He said **wait** and more,"]);
      expect(remainder).toBe(" then it continued on");
    });

    test("does not split at sentence punctuation inside an open bold span", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "**Wait. No** more.",
        false,
      );

      expect(segments).toEqual(["**Wait. No** more."]);
      expect(remainder).toBe("");
    });

    test("does not split at sentence punctuation inside an open italic span", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "*hold on. yes* it is done.",
        false,
      );

      expect(segments).toEqual(["*hold on. yes* it is done."]);
      expect(remainder).toBe("");
    });

    test("a lone arithmetic asterisk does not suppress sentence boundaries", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "The result of 5 * 3 is 15. And the next sentence keeps going",
        false,
      );

      expect(segments).toEqual(["The result of 5 * 3 is 15."]);
      expect(remainder).toBe(" And the next sentence keeps going");
    });

    test("a lone arithmetic asterisk does not suppress eager clause boundaries", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "The result of 5 * 3 is 15, and here is even more",
        false,
        { eager: true },
      );

      expect(segments).toEqual(["The result of 5 * 3 is 15,"]);
      expect(remainder).toBe(" and here is even more");
    });

    test("a line-start bullet asterisk does not suppress sentence boundaries", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "* bullet item with words. And more after it",
        false,
      );

      expect(segments).toEqual(["* bullet item with words."]);
      expect(remainder).toBe(" And more after it");
    });

    test("whitespace-padded asterisks do not suppress sentence boundaries", () => {
      // The sanitizer does not treat `* italic. still*` as an emphasis span
      // either, so splitting here keeps segment-level and whole-text
      // sanitization in agreement.
      const { segments, remainder } = extractSpeakableSegments(
        "Some * italic. still* done. And the next sentence keeps going",
        false,
      );

      expect(segments).toEqual(["Some * italic.", "still* done."]);
      expect(remainder).toBe(" And the next sentence keeps going");
    });

    test("does not split at sentence punctuation inside an open underscore span", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "This is _very important. Please listen_ now.",
        false,
      );

      expect(segments).toEqual([
        "This is _very important. Please listen_ now.",
      ]);
      expect(remainder).toBe("");
    });

    test("snake_case identifiers do not suppress sentence boundaries", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "Set my_var to 5. Then continue with the other_value here",
        false,
      );

      expect(segments).toEqual(["Set my_var to 5."]);
      expect(remainder).toBe(" Then continue with the other_value here");
    });

    test("whitespace-padded underscores do not suppress sentence boundaries", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "a _ b and c_ d happened. And the next sentence keeps going",
        false,
      );

      expect(segments).toEqual(["a _ b and c_ d happened."]);
      expect(remainder).toBe(" And the next sentence keeps going");
    });

    test("does not split at a clause boundary inside an open underscore span in eager mode", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "_underscored text that keeps going, more_ and then.",
        false,
        { eager: true },
      );

      expect(segments).toEqual([
        "_underscored text that keeps going, more_ and then.",
      ]);
      expect(remainder).toBe("");
    });

    test("does not split at a clause boundary inside an open italic span", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "*italic text that keeps going, more* and then.",
        false,
        { eager: true },
      );

      expect(segments).toEqual([
        "*italic text that keeps going, more* and then.",
      ]);
      expect(remainder).toBe("");
    });

    test("a short italic span with a comma stays intact in eager mode", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "*italic, text* more.",
        false,
        { eager: true },
      );

      expect(segments).toEqual(["*italic, text* more."]);
      expect(remainder).toBe("");
    });

    test("an unpaired bold marker still defers sentence boundaries", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "**important note. still inside the span",
        false,
      );

      expect(segments).toEqual([]);
      expect(remainder).toBe("**important note. still inside the span");
    });

    test("does not split at the newline after an opening code fence", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "```ts\ncode here``` done. And more",
        false,
      );

      expect(segments).toEqual(["```ts\ncode here``` done."]);
      expect(remainder).toBe(" And more");
    });

    test("does not split at a newline inside an open backtick span", () => {
      const text = "`code that spans\nlines and keeps going";

      const { segments, remainder } = extractSpeakableSegments(text, false);

      expect(segments).toEqual([]);
      expect(remainder).toBe(text);
    });

    test("splits at the newline once the backtick span closes", () => {
      const { segments, remainder } = extractSpeakableSegments(
        "`code that spans\nlines` done\nnext line",
        false,
      );

      expect(segments).toEqual(["`code that spans\nlines` done"]);
      expect(remainder).toBe("next line");
    });

    test("an unclosed span with newlines still flushes when forced", () => {
      const text = "```ts\nconst x = 1;";

      const { segments, remainder } = extractSpeakableSegments(text, true);

      expect(segments).toEqual([text]);
      expect(remainder).toBe("");
    });

    test("an unclosed span with newlines still flushes at the hard cap", () => {
      const text = `\`\`\`ts\n${"steady ".repeat(40)}`;

      const { segments } = extractSpeakableSegments(text, false);

      expect(segments).toHaveLength(1);
      expect((segments[0] ?? "").length).toBeLessThanOrEqual(
        DEFAULT_CHAR_THRESHOLD,
      );
    });

    test("an open span still flushes at the length-threshold hard cap", () => {
      const text = `**${"steady ".repeat(40)}`;

      const { segments } = extractSpeakableSegments(text, false);

      expect(segments).toHaveLength(1);
      expect((segments[0] ?? "").length).toBeLessThanOrEqual(
        DEFAULT_CHAR_THRESHOLD,
      );
    });
  });
});
