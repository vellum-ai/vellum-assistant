import { describe, expect, it } from 'bun:test';
import {
  invalidPath,
  pathOutOfBounds,
  pathNotAbsolute,
  notFound,
  notAFile,
  sizeLimitExceeded,
  matchNotFound,
  matchAmbiguous,
  ioError,
  type FsErrorCode,
} from '../tools/shared/filesystem/errors.js';

describe('shared filesystem error helpers', () => {
  it('invalidPath sets code and includes reason', () => {
    const err = invalidPath('/foo', 'contains null bytes');
    expect(err.code).toBe('INVALID_PATH' satisfies FsErrorCode);
    expect(err.path).toBe('/foo');
    expect(err.message).toContain('null bytes');
  });

  it('pathOutOfBounds includes path and boundary', () => {
    const err = pathOutOfBounds('../secret', '/sandbox');
    expect(err.code).toBe('PATH_OUT_OF_BOUNDS' satisfies FsErrorCode);
    expect(err.message).toContain('../secret');
    expect(err.message).toContain('/sandbox');
    expect(err.path).toBe('../secret');
  });

  it('pathNotAbsolute includes the offending path', () => {
    const err = pathNotAbsolute('relative/path');
    expect(err.code).toBe('PATH_NOT_ABSOLUTE' satisfies FsErrorCode);
    expect(err.message).toContain('relative/path');
    expect(err.path).toBe('relative/path');
  });

  it('notFound includes the path', () => {
    const err = notFound('/missing.txt');
    expect(err.code).toBe('NOT_FOUND' satisfies FsErrorCode);
    expect(err.message).toContain('/missing.txt');
  });

  it('notAFile includes the path', () => {
    const err = notAFile('/some/dir');
    expect(err.code).toBe('NOT_A_FILE' satisfies FsErrorCode);
    expect(err.message).toContain('/some/dir');
  });

  it('sizeLimitExceeded passes through detail message', () => {
    const detail = 'File size (200 MB) exceeds the 100 MB limit: /big.bin';
    const err = sizeLimitExceeded('/big.bin', detail);
    expect(err.code).toBe('SIZE_LIMIT_EXCEEDED' satisfies FsErrorCode);
    expect(err.message).toBe(detail);
    expect(err.path).toBe('/big.bin');
  });

  it('matchNotFound includes the path', () => {
    const err = matchNotFound('/file.ts');
    expect(err.code).toBe('MATCH_NOT_FOUND' satisfies FsErrorCode);
    expect(err.message).toContain('/file.ts');
  });

  it('matchAmbiguous includes count and path', () => {
    const err = matchAmbiguous('/file.ts', 3);
    expect(err.code).toBe('MATCH_AMBIGUOUS' satisfies FsErrorCode);
    expect(err.message).toContain('3 times');
    expect(err.message).toContain('/file.ts');
    expect(err.message).toContain('replace_all');
  });

  it('ioError includes detail', () => {
    const err = ioError('/file.ts', 'EACCES: permission denied');
    expect(err.code).toBe('IO_ERROR' satisfies FsErrorCode);
    expect(err.message).toContain('EACCES');
    expect(err.path).toBe('/file.ts');
  });
});
