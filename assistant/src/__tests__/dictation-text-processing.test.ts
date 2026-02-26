import { describe, expect, test } from 'bun:test';

import type { DictationDictionaryEntry,DictationSnippet } from '../daemon/dictation-profile-store.js';
import { applyDictionary,expandSnippets } from '../daemon/dictation-text-processing.js';

describe('expandSnippets', () => {
  test('expands triggers case-insensitively with longest match winning', () => {
    const snippets: DictationSnippet[] = [
      { trigger: 'brb', expansion: 'be right back' },
      { trigger: 'ttyl', expansion: 'talk to you later' },
    ];
    expect(expandSnippets('BRB and ttyl', snippets)).toBe('be right back and talk to you later');
  });

  test('skips disabled snippets', () => {
    const snippets: DictationSnippet[] = [
      { trigger: 'brb', expansion: 'be right back', enabled: false },
    ];
    expect(expandSnippets('brb soon', snippets)).toBe('brb soon');
  });

  test('no recursive expansion', () => {
    const snippets: DictationSnippet[] = [
      { trigger: 'a', expansion: 'b' },
      { trigger: 'b', expansion: 'c' },
    ];
    expect(expandSnippets('a test', snippets)).toBe('b test');
  });

  test('handles regex special chars and empty inputs', () => {
    expect(expandSnippets('I love C++ programming', [{ trigger: 'C++', expansion: 'CPP' }])).toBe('I love CPP programming');
    expect(expandSnippets('', [{ trigger: 'a', expansion: 'b' }])).toBe('');
    expect(expandSnippets('hello', undefined)).toBe('hello');
  });
});

describe('applyDictionary', () => {
  test('replaces whole words case-insensitively by default', () => {
    const dict: DictationDictionaryEntry[] = [
      { spoken: 'gonna', written: 'going to' },
      { spoken: 'the', written: 'THE' },
    ];
    expect(applyDictionary('Gonna do it', dict)).toBe('going to do it');
    expect(applyDictionary('the cat is there', dict)).toBe('THE cat is there');
  });

  test('respects caseSensitive and wholeWord options', () => {
    expect(applyDictionary('The api is ready', [
      { spoken: 'API', written: 'Interface', caseSensitive: true },
    ])).toBe('The api is ready');

    expect(applyDictionary('colorful', [
      { spoken: 'color', written: 'colour', wholeWord: false },
    ])).toBe('colourful');
  });

  test('handles regex special chars and empty inputs', () => {
    expect(applyDictionary('Use C++ here', [{ spoken: 'C++', written: 'CPP' }])).toBe('Use CPP here');
    expect(applyDictionary('hello', undefined)).toBe('hello');
  });
});
