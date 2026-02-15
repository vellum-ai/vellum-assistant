import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { migratePath } from '../util/platform.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `move-helper-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('migratePath', () => {
  test('no-op when source does not exist', () => {
    const tmp = makeTmpDir();
    const src = join(tmp, 'missing');
    const dst = join(tmp, 'dest');

    migratePath(src, dst);

    expect(existsSync(dst)).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });

  test('moves source file to destination', () => {
    const tmp = makeTmpDir();
    const src = join(tmp, 'source.txt');
    const dst = join(tmp, 'dest.txt');
    writeFileSync(src, 'hello');

    migratePath(src, dst);

    expect(existsSync(src)).toBe(false);
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst, 'utf-8')).toBe('hello');
    rmSync(tmp, { recursive: true, force: true });
  });

  test('moves source directory to destination', () => {
    const tmp = makeTmpDir();
    const src = join(tmp, 'srcdir');
    mkdirSync(src);
    writeFileSync(join(src, 'file.txt'), 'content');
    const dst = join(tmp, 'dstdir');

    migratePath(src, dst);

    expect(existsSync(src)).toBe(false);
    expect(existsSync(join(dst, 'file.txt'))).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  test('no-op when destination already exists', () => {
    const tmp = makeTmpDir();
    const src = join(tmp, 'source.txt');
    const dst = join(tmp, 'dest.txt');
    writeFileSync(src, 'source-content');
    writeFileSync(dst, 'existing-content');

    migratePath(src, dst);

    // Source should remain untouched
    expect(existsSync(src)).toBe(true);
    expect(readFileSync(src, 'utf-8')).toBe('source-content');
    // Destination should keep its original content
    expect(readFileSync(dst, 'utf-8')).toBe('existing-content');
    rmSync(tmp, { recursive: true, force: true });
  });

  test('creates destination parent directories', () => {
    const tmp = makeTmpDir();
    const src = join(tmp, 'source.txt');
    const dst = join(tmp, 'nested', 'deep', 'dest.txt');
    writeFileSync(src, 'hello');

    migratePath(src, dst);

    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst, 'utf-8')).toBe('hello');
    rmSync(tmp, { recursive: true, force: true });
  });

  test('idempotent: second call is no-op after successful move', () => {
    const tmp = makeTmpDir();
    const src = join(tmp, 'source.txt');
    const dst = join(tmp, 'dest.txt');
    writeFileSync(src, 'hello');

    migratePath(src, dst);
    // Source is gone, so second call is a no-op
    migratePath(src, dst);

    expect(existsSync(src)).toBe(false);
    expect(readFileSync(dst, 'utf-8')).toBe('hello');
    rmSync(tmp, { recursive: true, force: true });
  });
});
