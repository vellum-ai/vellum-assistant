import { describe, expect, test } from 'bun:test';
import { expandSnippets, applyDictionary } from '../daemon/dictation-text-processing.js';
import type { DictationSnippet, DictationDictionaryEntry } from '../daemon/dictation-profile-store.js';

describe('expandSnippets', () => {
  test('basic expansion', () => {
    const snippets: DictationSnippet[] = [
      { trigger: 'brb', expansion: 'be right back' },
    ];
    expect(expandSnippets('I will brb soon', snippets)).toBe('I will be right back soon');
  });

  test('longest trigger wins', () => {
    const snippets: DictationSnippet[] = [
      { trigger: 'on my way', expansion: 'on my way!' },
      { trigger: 'omw', expansion: 'on my way' },
    ];
    expect(expandSnippets('omw to the office', snippets)).toBe('on my way to the office');
  });

  test('case-insensitive matching', () => {
    const snippets: DictationSnippet[] = [
      { trigger: 'brb', expansion: 'be right back' },
    ];
    expect(expandSnippets('BRB soon', snippets)).toBe('be right back soon');
  });

  test('disabled snippets are skipped', () => {
    const snippets: DictationSnippet[] = [
      { trigger: 'brb', expansion: 'be right back', enabled: false },
    ];
    expect(expandSnippets('brb soon', snippets)).toBe('brb soon');
  });

  test('multi-word triggers work', () => {
    const snippets: DictationSnippet[] = [
      { trigger: 'on my way', expansion: 'OMW! Be there shortly.' },
    ];
    expect(expandSnippets('I am on my way now', snippets)).toBe('I am OMW! Be there shortly. now');
  });

  test('no recursive expansion', () => {
    const snippets: DictationSnippet[] = [
      { trigger: 'a', expansion: 'b' },
      { trigger: 'b', expansion: 'c' },
    ];
    // 'a' expands to 'b', but that 'b' should NOT further expand to 'c'
    const result = expandSnippets('a test', snippets);
    expect(result).toBe('b test');
  });

  test('regex special chars in triggers are escaped', () => {
    const snippets: DictationSnippet[] = [
      { trigger: 'C++', expansion: 'C Plus Plus' },
    ];
    expect(expandSnippets('I love C++ programming', snippets)).toBe('I love C Plus Plus programming');
  });

  test('empty inputs are no-ops', () => {
    expect(expandSnippets('', [{ trigger: 'a', expansion: 'b' }])).toBe('');
    expect(expandSnippets('hello', [])).toBe('hello');
    expect(expandSnippets('hello', undefined)).toBe('hello');
  });

  test('multiple snippets in one text', () => {
    const snippets: DictationSnippet[] = [
      { trigger: 'brb', expansion: 'be right back' },
      { trigger: 'ttyl', expansion: 'talk to you later' },
    ];
    expect(expandSnippets('brb and ttyl', snippets)).toBe('be right back and talk to you later');
  });
});

describe('applyDictionary', () => {
  test('basic replacement', () => {
    const dict: DictationDictionaryEntry[] = [
      { spoken: 'gonna', written: 'going to' },
    ];
    expect(applyDictionary('I am gonna do it', dict)).toBe('I am going to do it');
  });

  test('whole word matching (default)', () => {
    const dict: DictationDictionaryEntry[] = [
      { spoken: 'the', written: 'THE' },
    ];
    // Should not match 'the' inside 'there'
    const result = applyDictionary('the cat is there', dict);
    expect(result).toBe('THE cat is there');
  });

  test('non-whole-word matching', () => {
    const dict: DictationDictionaryEntry[] = [
      { spoken: 'color', written: 'colour', wholeWord: false },
    ];
    expect(applyDictionary('colorful colors', dict)).toBe('colourful colours');
  });

  test('case-insensitive by default', () => {
    const dict: DictationDictionaryEntry[] = [
      { spoken: 'gonna', written: 'going to' },
    ];
    expect(applyDictionary('Gonna do it', dict)).toBe('going to do it');
  });

  test('case-sensitive matching', () => {
    const dict: DictationDictionaryEntry[] = [
      { spoken: 'API', written: 'Application Programming Interface', caseSensitive: true },
    ];
    expect(applyDictionary('The API is ready', dict)).toBe('The Application Programming Interface is ready');
    expect(applyDictionary('The api is ready', dict)).toBe('The api is ready');
  });

  test('multiple dictionary entries', () => {
    const dict: DictationDictionaryEntry[] = [
      { spoken: 'gonna', written: 'going to' },
      { spoken: 'wanna', written: 'want to' },
    ];
    expect(applyDictionary('I wanna and gonna', dict)).toBe('I want to and going to');
  });

  test('empty inputs are no-ops', () => {
    expect(applyDictionary('', [{ spoken: 'a', written: 'b' }])).toBe('');
    expect(applyDictionary('hello', [])).toBe('hello');
    expect(applyDictionary('hello', undefined)).toBe('hello');
  });

  test('regex special chars in spoken are escaped', () => {
    const dict: DictationDictionaryEntry[] = [
      { spoken: 'C++', written: 'CPP' },
    ];
    expect(applyDictionary('Use C++ here', dict)).toBe('Use CPP here');
  });

  test('longest spoken wins when overlapping', () => {
    const dict: DictationDictionaryEntry[] = [
      { spoken: 'New York', written: 'NYC' },
      { spoken: 'New York City', written: 'NYC (full)' },
    ];
    expect(applyDictionary('Visit New York City today', dict)).toBe('Visit NYC (full) today');
  });
});
