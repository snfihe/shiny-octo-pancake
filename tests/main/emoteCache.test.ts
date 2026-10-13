import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CACHE_MAX_BYTES, CACHE_MAX_FILES, EmoteCache, verifyStill } from '../../src/main/emoteCache';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const padded = (head: number[], total: number, fill = 7): Uint8Array => {
  const out = new Uint8Array(Math.max(total, head.length)).fill(fill);
  out.set(head);
  return out;
};

/** A lossy WebP still with real headers: only these are read, which is all a cache check can see. */
const still = (w = 160, h = 120, total = 600): Uint8Array =>
  padded([...ascii('RIFF'), ...le32(total - 8), ...ascii('WEBPVP8 '), ...le32(total - 20), 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)], total);
/** An extended-format WebP with the animation flag set: a friend must not be able to hand us a moving picture. */
const animated = (total = 600): Uint8Array =>
  padded([...ascii('RIFF'), ...le32(total - 8), ...ascii('WEBPVP8X'), ...le32(10), 0x02, 0, 0, 0, ...le24(159), ...le24(119)], total);
const png = (): Uint8Array => padded([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 300);

const hashOf = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex').slice(0, 32);

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lolping-cache-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A cache with a clock the test turns, so "least recently used" is the test's decision and not the machine's. */
function cache(limits = { files: CACHE_MAX_FILES, bytes: CACHE_MAX_BYTES }) {
  let at = 1000;
  const dir = join(tempDir(), 'emote-cache');
  const c = new EmoteCache(dir, () => at, limits);
  const advance = (): void => {
    at += 10;
  };
  const add = async (bytes: Uint8Array): Promise<string> => {
    advance();
    const hash = hashOf(bytes);
    expect(await c.put(hash, bytes)).toBe(true);
    return hash;
  };
  return { c, dir, advance, add };
}

describe('verifyStill', () => {
  it('accepts only the bytes whose hash was asked for', () => {
    const image = still();
    expect(verifyStill(hashOf(image), image)).toBe(true);
    expect(verifyStill(hashOf(still(160, 120, 601)), image)).toBe(false);
  });

  it('rejects anything that is not a still WebP of at most 160 px', () => {
    expect(verifyStill(hashOf(png()), png())).toBe(false);
    expect(verifyStill(hashOf(animated()), animated())).toBe(false);
    expect(verifyStill(hashOf(still(512, 8)), still(512, 8))).toBe(false);
    expect(verifyStill(hashOf(still(8, 8, 12_289)), still(8, 8, 12_289))).toBe(false);
    expect(verifyStill(hashOf(new Uint8Array(0)), new Uint8Array(0))).toBe(false);
  });
});

describe('EmoteCache', () => {
  it('stores a verified still and finds it again', async () => {
    const { c, dir, add } = cache();
    const image = still();
    const hash = await add(image);
    expect(c.has(hash)).toBe(true);
    expect(new Uint8Array(readFileSync(join(dir, `${hash}.webp`)))).toEqual(image);
  });

  it('refuses an image that is not what the hash promised, and writes nothing', async () => {
    const { c, dir } = cache();
    const other = still(100, 100);
    expect(await c.put(hashOf(still(64, 64)), other)).toBe(false);
    expect(c.has(hashOf(other))).toBe(false);
    expect(existsSync(dir)).toBe(false); // the folder is not even made for a refused image
  });

  it('is content to be told the same image twice', async () => {
    const { c } = cache();
    const image = still();
    const hash = hashOf(image);
    expect(await c.put(hash, image)).toBe(true);
    expect(await c.put(hash, image)).toBe(true);
    expect(c.has(hash)).toBe(true);
  });

  it('evicts by least recent use, and reading an image makes it the most recent', async () => {
    const { c, add, advance } = cache({ files: 2, bytes: 10_000 });
    const a = await add(still(10, 10));
    const b = await add(still(20, 20));
    advance();
    expect(c.has(a)).toBe(true); // a is fresher than b now
    const d = await add(still(30, 30));
    expect(c.has(b)).toBe(false);
    expect(c.has(a)).toBe(true);
    expect(c.has(d)).toBe(true);
  });

  it('evicts by bytes as well as by count', async () => {
    const { c, add } = cache({ files: 99, bytes: 700 });
    const a = await add(still(10, 10, 600));
    const b = await add(still(20, 20, 600));
    expect(c.has(a)).toBe(false);
    expect(c.has(b)).toBe(true);
  });

  it('adopts what is already on disk, in mtime order, and trims to the caps', async () => {
    const dir = join(tempDir(), 'emote-cache');
    mkdirSync(dir, { recursive: true });
    const images = [still(10, 10), still(20, 20), still(30, 30)];
    const base = Date.now() - 30_000;
    images.forEach((image, k) => {
      const path = join(dir, `${hashOf(image)}.webp`);
      writeFileSync(path, image);
      const at = new Date(base + k * 1000); // the loop above is faster than the filesystem's own clock
      utimesSync(path, at, at);
    });
    const c = new EmoteCache(dir, () => 1, { files: 2, bytes: 100_000 });
    await c.load();
    expect(images.map((image) => c.has(hashOf(image)))).toEqual([false, true, true]);
  });

  it('treats a missing folder as an empty cache rather than an error', async () => {
    const c = new EmoteCache(join(tempDir(), 'nowhere'));
    await c.load();
    expect(c.has(hashOf(still()))).toBe(false);
  });

  it('notices a file deleted behind its back', async () => {
    const { c, dir, add } = cache();
    const hash = await add(still());
    rmSync(join(dir, `${hash}.webp`));
    expect(c.has(hash)).toBe(false);
    expect(c.has(hash)).toBe(false); // still gone, and no longer remembered as present
  });
});
