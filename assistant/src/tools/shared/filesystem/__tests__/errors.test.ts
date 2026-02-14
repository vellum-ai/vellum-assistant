import { describe, test, expect } from 'bun:test';
import {
  FilesystemError,
  invalidPath,
  pathOutOfBounds,
  pathNotAbsolute,
  notFound,
  notAFile,
  sizeLimitExceeded,
  matchNotFound,
  matchAmbiguous,
  ioError,
} from '../errors.js';

describe('FilesystemError helpers', () => {
  test('invalidPath', () => {
    const err = invalidPath('foo/../bar', 'contains traversal');
    expect(err).toBeInstanceOf(FilesystemError);
    expect(err.code).toBe('INVALID_PATH');
    expect(err.message).toContain('foo/../bar');
    expect(err.message).toContain('contains traversal');
  });

  test('invalidPath without reason', () => {
    const err = invalidPath('');
    expect(err.code).toBe('INVALID_PATH');
    expect(err.message).not.toContain(':');
  });

  test('pathOutOfBounds', () => {
    const err = pathOutOfBounds('/etc/passwd', '/home/user/project');
    expect(err.code).toBe('PATH_OUT_OF_BOUNDS');
    expect(err.message).toContain('/etc/passwd');
    expect(err.message).toContain('/home/user/project');
  });

  test('pathNotAbsolute', () => {
    const err = pathNotAbsolute('relative/path.txt');
    expect(err.code).toBe('PATH_NOT_ABSOLUTE');
    expect(err.message).toContain('relative/path.txt');
  });

  test('notFound', () => {
    const err = notFound('/missing/file.ts');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toContain('/missing/file.ts');
  });

  test('notAFile', () => {
    const err = notAFile('/some/directory');
    expect(err.code).toBe('NOT_A_FILE');
    expect(err.message).toContain('/some/directory');
  });

  test('sizeLimitExceeded', () => {
    const err = sizeLimitExceeded('/big/file.bin', '150.0 MB', '100.0 MB');
    expect(err.code).toBe('SIZE_LIMIT_EXCEEDED');
    expect(err.message).toContain('150.0 MB');
    expect(err.message).toContain('100.0 MB');
  });

  test('matchNotFound', () => {
    const err = matchNotFound('/src/app.ts');
    expect(err.code).toBe('MATCH_NOT_FOUND');
    expect(err.message).toContain('/src/app.ts');
  });

  test('matchAmbiguous', () => {
    const err = matchAmbiguous('/src/app.ts', 3);
    expect(err.code).toBe('MATCH_AMBIGUOUS');
    expect(err.message).toContain('3');
    expect(err.message).toContain('/src/app.ts');
  });

  test('ioError', () => {
    const err = ioError('/locked/file', 'permission denied');
    expect(err.code).toBe('IO_ERROR');
    expect(err.message).toContain('/locked/file');
    expect(err.message).toContain('permission denied');
  });

  test('all errors have name "FilesystemError"', () => {
    const errors = [
      invalidPath('x'),
      pathOutOfBounds('x', 'y'),
      pathNotAbsolute('x'),
      notFound('x'),
      notAFile('x'),
      sizeLimitExceeded('x', '1', '2'),
      matchNotFound('x'),
      matchAmbiguous('x', 2),
      ioError('x', 'y'),
    ];
    for (const err of errors) {
      expect(err.name).toBe('FilesystemError');
      expect(err).toBeInstanceOf(Error);
    }
  });
});
