import { describe, test, expect } from 'bun:test';
import { renderWorkspaceTopLevelContext } from '../workspace/top-level-renderer.js';
import type { TopLevelSnapshot } from '../workspace/top-level-scanner.js';

describe('renderWorkspaceTopLevelContext', () => {
  test('renders basic snapshot with directories', () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: '/sandbox',
      directories: ['lib', 'src', 'tests'],
      truncated: false,
    };

    const result = renderWorkspaceTopLevelContext(snapshot);
    expect(result).toBe([
      '<workspace_top_level>',
      'Root: /sandbox',
      'Directories: lib, src, tests',
      '</workspace_top_level>',
    ].join('\n'));
  });

  test('includes truncation note when truncated', () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: '/sandbox',
      directories: ['a', 'b'],
      truncated: true,
    };

    const result = renderWorkspaceTopLevelContext(snapshot);
    expect(result).toContain('(list truncated — more directories exist)');
    expect(result).toContain('Directories: a, b');
  });

  test('does not include truncation note when not truncated', () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: '/sandbox',
      directories: ['src'],
      truncated: false,
    };

    const result = renderWorkspaceTopLevelContext(snapshot);
    expect(result).not.toContain('truncated');
  });

  test('renders empty directory list', () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: '/empty',
      directories: [],
      truncated: false,
    };

    const result = renderWorkspaceTopLevelContext(snapshot);
    expect(result).toBe([
      '<workspace_top_level>',
      'Root: /empty',
      'Directories: ',
      '</workspace_top_level>',
    ].join('\n'));
  });

  test('produces stable output for equal input', () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: '/sandbox',
      directories: ['alpha', 'beta', 'gamma'],
      truncated: false,
    };

    const r1 = renderWorkspaceTopLevelContext(snapshot);
    const r2 = renderWorkspaceTopLevelContext(snapshot);
    expect(r1).toBe(r2);
  });

  test('starts with opening tag and ends with closing tag', () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: '/test',
      directories: ['src'],
      truncated: false,
    };

    const result = renderWorkspaceTopLevelContext(snapshot);
    expect(result.startsWith('<workspace_top_level>')).toBe(true);
    expect(result.endsWith('</workspace_top_level>')).toBe(true);
  });

  test('includes hidden directories', () => {
    const snapshot: TopLevelSnapshot = {
      rootPath: '/project',
      directories: ['.git', '.vscode', 'src'],
      truncated: false,
    };

    const result = renderWorkspaceTopLevelContext(snapshot);
    expect(result).toContain('.git');
    expect(result).toContain('.vscode');
    expect(result).toContain('src');
  });
});
