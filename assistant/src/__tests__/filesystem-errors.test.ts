import { describe, expect, it } from 'bun:test';
import {
  FilesystemError,
  FilesystemErrorCode,
  invalidPath,
  pathOutOfBounds,
  pathNotAbsolute,
  notFound,
  notAFile,
  sizeLimitExceeded,
  matchNotFound,
  matchAmbiguous,
  ioError,
} from '../tools/shared/filesystem/errors.js';

describe('FilesystemError', () => {
  it('extends Error with code and path', () => {
    const err = new FilesystemError(FilesystemErrorCode.NOT_FOUND, 'gone', '/tmp/x');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('FilesystemError');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.path).toBe('/tmp/x');
    expect(err.message).toBe('gone');
  });

  it('path is optional', () => {
    const err = new FilesystemError(FilesystemErrorCode.INVALID_PATH, 'bad');
    expect(err.path).toBeUndefined();
  });
});

describe('helper constructors', () => {
  it('invalidPath', () => {
    const err = invalidPath('path must be a string');
    expect(err.code).toBe(FilesystemErrorCode.INVALID_PATH);
    expect(err.message).toBe('path must be a string');
    expect(err.path).toBeUndefined();
  });

  it('pathOutOfBounds', () => {
    const err = pathOutOfBounds('../secret', '/etc/secret', '/home/user');
    expect(err.code).toBe(FilesystemErrorCode.PATH_OUT_OF_BOUNDS);
    expect(err.message).toContain('../secret');
    expect(err.message).toContain('/etc/secret');
    expect(err.message).toContain('/home/user');
    expect(err.path).toBe('/etc/secret');
  });

  it('pathNotAbsolute', () => {
    const err = pathNotAbsolute('relative/path');
    expect(err.code).toBe(FilesystemErrorCode.PATH_NOT_ABSOLUTE);
    expect(err.message).toContain('relative/path');
    expect(err.path).toBe('relative/path');
  });

  it('notFound', () => {
    const err = notFound('/tmp/missing.txt');
    expect(err.code).toBe(FilesystemErrorCode.NOT_FOUND);
    expect(err.message).toContain('/tmp/missing.txt');
    expect(err.path).toBe('/tmp/missing.txt');
  });

  it('notAFile', () => {
    const err = notAFile('/tmp/dir');
    expect(err.code).toBe(FilesystemErrorCode.NOT_A_FILE);
    expect(err.message).toContain('directory');
    expect(err.path).toBe('/tmp/dir');
  });

  it('sizeLimitExceeded formats bytes', () => {
    const err = sizeLimitExceeded('/big.bin', 200 * 1024 * 1024, 100 * 1024 * 1024);
    expect(err.code).toBe(FilesystemErrorCode.SIZE_LIMIT_EXCEEDED);
    expect(err.message).toContain('200.0 MB');
    expect(err.message).toContain('100.0 MB');
    expect(err.path).toBe('/big.bin');
  });

  it('sizeLimitExceeded formats KB', () => {
    const err = sizeLimitExceeded('/f', 2048, 1024);
    expect(err.message).toContain('2.0 KB');
    expect(err.message).toContain('1.0 KB');
  });

  it('sizeLimitExceeded formats raw bytes', () => {
    const err = sizeLimitExceeded('/f', 500, 256);
    expect(err.message).toContain('500 B');
    expect(err.message).toContain('256 B');
  });

  it('matchNotFound', () => {
    const err = matchNotFound('/tmp/file.ts');
    expect(err.code).toBe(FilesystemErrorCode.MATCH_NOT_FOUND);
    expect(err.message).toContain('old_string not found');
    expect(err.path).toBe('/tmp/file.ts');
  });

  it('matchAmbiguous includes count', () => {
    const err = matchAmbiguous('/tmp/file.ts', 3);
    expect(err.code).toBe(FilesystemErrorCode.MATCH_AMBIGUOUS);
    expect(err.message).toContain('3 times');
    expect(err.message).toContain('replace_all');
    expect(err.path).toBe('/tmp/file.ts');
  });

  it('ioError wraps Error cause', () => {
    const cause = new Error('EACCES: permission denied');
    const err = ioError('/protected', cause);
    expect(err.code).toBe(FilesystemErrorCode.IO_ERROR);
    expect(err.message).toContain('EACCES');
    expect(err.path).toBe('/protected');
  });

  it('ioError wraps string cause', () => {
    const err = ioError('/file', 'something broke');
    expect(err.code).toBe(FilesystemErrorCode.IO_ERROR);
    expect(err.message).toContain('something broke');
  });
});

describe('FilesystemErrorCode exhaustiveness', () => {
  it('contains all expected codes', () => {
    const codes = Object.values(FilesystemErrorCode);
    expect(codes).toContain('INVALID_PATH');
    expect(codes).toContain('PATH_OUT_OF_BOUNDS');
    expect(codes).toContain('PATH_NOT_ABSOLUTE');
    expect(codes).toContain('NOT_FOUND');
    expect(codes).toContain('NOT_A_FILE');
    expect(codes).toContain('SIZE_LIMIT_EXCEEDED');
    expect(codes).toContain('MATCH_NOT_FOUND');
    expect(codes).toContain('MATCH_AMBIGUOUS');
    expect(codes).toContain('IO_ERROR');
    expect(codes).toHaveLength(9);
  });
});
