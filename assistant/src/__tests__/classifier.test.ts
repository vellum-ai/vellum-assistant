import { describe, test, expect } from 'bun:test';
import { classifyHeuristic } from '../daemon/classifier.js';

describe('classifyHeuristic', () => {
  test('question mark → text_qa', () => {
    expect(classifyHeuristic('What time is it?')).toBe('text_qa');
    expect(classifyHeuristic('Is the server running?')).toBe('text_qa');
  });

  test('QA starters → text_qa', () => {
    expect(classifyHeuristic('What is the capital of France')).toBe('text_qa');
    expect(classifyHeuristic('How does React work')).toBe('text_qa');
    expect(classifyHeuristic('Explain the difference between TCP and UDP')).toBe('text_qa');
    expect(classifyHeuristic('Tell me about Swift concurrency')).toBe('text_qa');
    expect(classifyHeuristic('Summarize the meeting notes')).toBe('text_qa');
    expect(classifyHeuristic('List all dependencies')).toBe('text_qa');
    expect(classifyHeuristic('Describe the architecture')).toBe('text_qa');
    expect(classifyHeuristic('Why is the sky blue')).toBe('text_qa');
    expect(classifyHeuristic('Who invented the telephone')).toBe('text_qa');
    expect(classifyHeuristic('Which framework is better')).toBe('text_qa');
    expect(classifyHeuristic('When was this released')).toBe('text_qa');
    expect(classifyHeuristic('Where is the config file')).toBe('text_qa');
    expect(classifyHeuristic('Can you explain this error')).toBe('text_qa');
    expect(classifyHeuristic('Can you describe the process')).toBe('text_qa');
    expect(classifyHeuristic('Can you tell me about TypeScript')).toBe('text_qa');
    expect(classifyHeuristic('Is it possible to do X')).toBe('text_qa');
    expect(classifyHeuristic('Is there a way to fix this')).toBe('text_qa');
    expect(classifyHeuristic('Is this the right approach')).toBe('text_qa');
    expect(classifyHeuristic('Are there alternatives')).toBe('text_qa');
    expect(classifyHeuristic('Are these values correct')).toBe('text_qa');
  });

  test('CU starters → computer_use', () => {
    expect(classifyHeuristic('Open Safari')).toBe('computer_use');
    expect(classifyHeuristic('Click the submit button')).toBe('computer_use');
    expect(classifyHeuristic('Type hello world in the text field')).toBe('computer_use');
    expect(classifyHeuristic('Navigate to google.com')).toBe('computer_use');
    expect(classifyHeuristic('Scroll down')).toBe('computer_use');
    expect(classifyHeuristic('Go to Settings')).toBe('computer_use');
    expect(classifyHeuristic('Launch Terminal')).toBe('computer_use');
    expect(classifyHeuristic('Close the window')).toBe('computer_use');
    expect(classifyHeuristic('Select all text')).toBe('computer_use');
    expect(classifyHeuristic('Copy this paragraph')).toBe('computer_use');
    expect(classifyHeuristic('Paste it here')).toBe('computer_use');
    expect(classifyHeuristic('Press enter')).toBe('computer_use');
    expect(classifyHeuristic('Show me the file')).toBe('computer_use');
    expect(classifyHeuristic('Find the settings menu')).toBe('computer_use');
    expect(classifyHeuristic('Search for cats')).toBe('computer_use');
    expect(classifyHeuristic('Run the build script')).toBe('computer_use');
  });

  test('ambiguous / default → computer_use', () => {
    expect(classifyHeuristic('Make the app faster')).toBe('computer_use');
    expect(classifyHeuristic('Fix the bug')).toBe('computer_use');
    expect(classifyHeuristic('Use the attached files as context.')).toBe('computer_use');
  });

  test('case insensitive', () => {
    expect(classifyHeuristic('WHAT IS THIS')).toBe('text_qa');
    expect(classifyHeuristic('OPEN Safari')).toBe('computer_use');
  });

  test('leading/trailing whitespace is trimmed', () => {
    expect(classifyHeuristic('  What is this  ')).toBe('text_qa');
    expect(classifyHeuristic('  Open Safari  ')).toBe('computer_use');
  });
});
