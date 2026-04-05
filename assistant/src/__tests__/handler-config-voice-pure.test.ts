import { describe, expect, test } from "bun:test";

import { normalizeActivationKey } from "../daemon/handlers/config-voice.js";

// ---------------------------------------------------------------------------
// Legacy enum values
// ---------------------------------------------------------------------------

describe("normalizeActivationKey — legacy enums", () => {
  test("fn", () => {
    expect(normalizeActivationKey("fn")).toEqual({ ok: true, value: "fn" });
  });

  test("ctrl", () => {
    expect(normalizeActivationKey("ctrl")).toEqual({ ok: true, value: "ctrl" });
  });

  test("fn_shift", () => {
    expect(normalizeActivationKey("fn_shift")).toEqual({
      ok: true,
      value: "fn_shift",
    });
  });

  test("none", () => {
    expect(normalizeActivationKey("none")).toEqual({
      ok: true,
      value: "none",
    });
  });

  test("case insensitive: Fn", () => {
    expect(normalizeActivationKey("Fn")).toEqual({ ok: true, value: "fn" });
  });

  test("case insensitive: CTRL", () => {
    expect(normalizeActivationKey("CTRL")).toEqual({
      ok: true,
      value: "ctrl",
    });
  });

  test("case insensitive: NONE", () => {
    expect(normalizeActivationKey("NONE")).toEqual({
      ok: true,
      value: "none",
    });
  });

  test("leading/trailing whitespace stripped", () => {
    expect(normalizeActivationKey("  fn  ")).toEqual({
      ok: true,
      value: "fn",
    });
  });
});

// ---------------------------------------------------------------------------
// Natural language mappings
// ---------------------------------------------------------------------------

describe("normalizeActivationKey — natural language", () => {
  test("globe → fn", () => {
    expect(normalizeActivationKey("globe")).toEqual({
      ok: true,
      value: "fn",
    });
  });

  test("Globe (capitalized) → fn", () => {
    expect(normalizeActivationKey("Globe")).toEqual({
      ok: true,
      value: "fn",
    });
  });

  test("fn key → fn", () => {
    expect(normalizeActivationKey("fn key")).toEqual({
      ok: true,
      value: "fn",
    });
  });

  test("globe key → fn", () => {
    expect(normalizeActivationKey("globe key")).toEqual({
      ok: true,
      value: "fn",
    });
  });

  test("control → ctrl", () => {
    expect(normalizeActivationKey("control")).toEqual({
      ok: true,
      value: "ctrl",
    });
  });

  test("ctrl key → ctrl", () => {
    expect(normalizeActivationKey("ctrl key")).toEqual({
      ok: true,
      value: "ctrl",
    });
  });

  test("control key → ctrl", () => {
    expect(normalizeActivationKey("control key")).toEqual({
      ok: true,
      value: "ctrl",
    });
  });

  test("fn+shift → fn_shift", () => {
    expect(normalizeActivationKey("fn+shift")).toEqual({
      ok: true,
      value: "fn_shift",
    });
  });

  test("fn shift → fn_shift", () => {
    expect(normalizeActivationKey("fn shift")).toEqual({
      ok: true,
      value: "fn_shift",
    });
  });

  test("shift+fn → fn_shift", () => {
    expect(normalizeActivationKey("shift+fn")).toEqual({
      ok: true,
      value: "fn_shift",
    });
  });

  test("off → none", () => {
    expect(normalizeActivationKey("off")).toEqual({
      ok: true,
      value: "none",
    });
  });

  test("disabled → none", () => {
    expect(normalizeActivationKey("disabled")).toEqual({
      ok: true,
      value: "none",
    });
  });

  test("disable → none", () => {
    expect(normalizeActivationKey("disable")).toEqual({
      ok: true,
      value: "none",
    });
  });
});

// ---------------------------------------------------------------------------
// PTTActivator JSON — valid payloads
// ---------------------------------------------------------------------------

describe("normalizeActivationKey — valid PTTActivator JSON", () => {
  test("modifierOnly with modifierFlags", () => {
    const input = '{"kind":"modifierOnly","modifierFlags":96}';
    const result = normalizeActivationKey(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(input);
  });

  test("key with keyCode", () => {
    const input = '{"kind":"key","keyCode":49}';
    const result = normalizeActivationKey(input);
    expect(result.ok).toBe(true);
  });

  test("key with keyCode 0 (minimum)", () => {
    const input = '{"kind":"key","keyCode":0}';
    const result = normalizeActivationKey(input);
    expect(result.ok).toBe(true);
  });

  test("key with keyCode 255 (maximum)", () => {
    const input = '{"kind":"key","keyCode":255}';
    const result = normalizeActivationKey(input);
    expect(result.ok).toBe(true);
  });

  test("modifierKey with keyCode and modifierFlags", () => {
    const input = '{"kind":"modifierKey","keyCode":49,"modifierFlags":256}';
    const result = normalizeActivationKey(input);
    expect(result.ok).toBe(true);
  });

  test("mouseButton with button >= 2", () => {
    const input = '{"kind":"mouseButton","mouseButton":3}';
    const result = normalizeActivationKey(input);
    expect(result.ok).toBe(true);
  });

  test("none kind", () => {
    const input = '{"kind":"none"}';
    const result = normalizeActivationKey(input);
    expect(result.ok).toBe(true);
  });

  test("key with optional modifierFlags (allowed for key kind)", () => {
    const input = '{"kind":"key","keyCode":49,"modifierFlags":256}';
    const result = normalizeActivationKey(input);
    // key kind doesn't forbid modifierFlags, only forbids mouseButton
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PTTActivator JSON — invalid payloads
// ---------------------------------------------------------------------------

describe("normalizeActivationKey — invalid PTTActivator JSON", () => {
  test("invalid kind", () => {
    const result = normalizeActivationKey('{"kind":"invalid"}');
    expect(result.ok).toBe(false);
  });

  test("modifierOnly without modifierFlags", () => {
    const result = normalizeActivationKey('{"kind":"modifierOnly"}');
    expect(result.ok).toBe(false);
  });

  test("modifierOnly with keyCode (forbidden)", () => {
    const result = normalizeActivationKey(
      '{"kind":"modifierOnly","modifierFlags":96,"keyCode":1}',
    );
    expect(result.ok).toBe(false);
  });

  test("modifierOnly with mouseButton (forbidden)", () => {
    const result = normalizeActivationKey(
      '{"kind":"modifierOnly","modifierFlags":96,"mouseButton":3}',
    );
    expect(result.ok).toBe(false);
  });

  test("key without keyCode", () => {
    const result = normalizeActivationKey('{"kind":"key"}');
    expect(result.ok).toBe(false);
  });

  test("key with keyCode out of range (> 255)", () => {
    const result = normalizeActivationKey('{"kind":"key","keyCode":300}');
    expect(result.ok).toBe(false);
  });

  test("key with keyCode out of range (< 0)", () => {
    const result = normalizeActivationKey('{"kind":"key","keyCode":-1}');
    expect(result.ok).toBe(false);
  });

  test("key with mouseButton (forbidden)", () => {
    const result = normalizeActivationKey(
      '{"kind":"key","keyCode":49,"mouseButton":3}',
    );
    expect(result.ok).toBe(false);
  });

  test("modifierKey without keyCode", () => {
    const result = normalizeActivationKey(
      '{"kind":"modifierKey","modifierFlags":256}',
    );
    expect(result.ok).toBe(false);
  });

  test("modifierKey without modifierFlags", () => {
    const result = normalizeActivationKey(
      '{"kind":"modifierKey","keyCode":49}',
    );
    expect(result.ok).toBe(false);
  });

  test("modifierKey with keyCode out of range", () => {
    const result = normalizeActivationKey(
      '{"kind":"modifierKey","keyCode":300,"modifierFlags":256}',
    );
    expect(result.ok).toBe(false);
  });

  test("modifierKey with mouseButton (forbidden)", () => {
    const result = normalizeActivationKey(
      '{"kind":"modifierKey","keyCode":49,"modifierFlags":256,"mouseButton":3}',
    );
    expect(result.ok).toBe(false);
  });

  test("mouseButton without mouseButton field", () => {
    const result = normalizeActivationKey('{"kind":"mouseButton"}');
    expect(result.ok).toBe(false);
  });

  test("mouseButton with reserved button 0 (left click)", () => {
    const result = normalizeActivationKey(
      '{"kind":"mouseButton","mouseButton":0}',
    );
    expect(result.ok).toBe(false);
  });

  test("mouseButton with reserved button 1 (right click)", () => {
    const result = normalizeActivationKey(
      '{"kind":"mouseButton","mouseButton":1}',
    );
    expect(result.ok).toBe(false);
  });

  test("mouseButton with keyCode (forbidden)", () => {
    const result = normalizeActivationKey(
      '{"kind":"mouseButton","mouseButton":3,"keyCode":49}',
    );
    expect(result.ok).toBe(false);
  });

  test("non-numeric keyCode (string)", () => {
    const result = normalizeActivationKey('{"kind":"key","keyCode":"49"}');
    expect(result.ok).toBe(false);
  });

  test("non-numeric modifierFlags (string)", () => {
    const result = normalizeActivationKey(
      '{"kind":"modifierOnly","modifierFlags":"96"}',
    );
    expect(result.ok).toBe(false);
  });

  test("non-numeric mouseButton (string)", () => {
    const result = normalizeActivationKey(
      '{"kind":"mouseButton","mouseButton":"3"}',
    );
    expect(result.ok).toBe(false);
  });

  test("malformed JSON", () => {
    const result = normalizeActivationKey('{"kind":');
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invalid string inputs
// ---------------------------------------------------------------------------

describe("normalizeActivationKey — invalid inputs", () => {
  test("unrecognized string", () => {
    const result = normalizeActivationKey("not_a_key");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Invalid activation key");
  });

  test("empty string", () => {
    const result = normalizeActivationKey("");
    expect(result.ok).toBe(false);
  });

  test("whitespace only", () => {
    const result = normalizeActivationKey("   ");
    expect(result.ok).toBe(false);
  });

  test("partial match (fns)", () => {
    const result = normalizeActivationKey("fns");
    expect(result.ok).toBe(false);
  });
});
