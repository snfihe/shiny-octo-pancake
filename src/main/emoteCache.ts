import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STILL_MAX_BYTES, STILL_SIDE } from '../shared/emotes';
import { isAnimatedWebp, sniffImage, webpSize } from '../shared/imageSniff';
import { isFile } from './fileState';
import { renameWithRetry } from './settingsStore';

/** The stated caps: 200 stills of at most 12 KB each is under 4 MB, so either limit can be the one that bites. */
export const CACHE_MAX_FILES = 200;
export const CACHE_MAX_BYTES = 4 * 1024 * 1024;

const CACHED = /^([0-9a-f]{32})\.webp$/;
const longest = (size: { width: number; height: number }): number => Math.max(size.width, size.height);

/**
 * Whether `bytes` really is the still whose id is `hash`: the hash of the bytes must be the one the room announced, so no
 * member can hand out a different image under someone else's id. The size and header checks are the ones an import passes,
 * so a friend's still can't arrive bigger or animated.
 */
export function verifyStill(hash: string, bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.length > STILL_MAX_BYTES) return false;
  if (createHash('sha256').update(bytes).digest('hex').slice(0, 32) !== hash) return false;
  if (sniffImage(bytes) !== 'webp' || isAnimatedWebp(bytes)) return false;
  const size = webpSize(bytes);
  return size !== null && longest(size) <= STILL_SIDE;
}

/**
 * Stills that arrived from other people's rooms, in <settings folder>/emote-cache. Nothing is read from here without a
 * hash check first, and the folder is disposable: losing it only means a friend's emote shows as the "?" once more.
 */
export class EmoteCache {
  /** hash -> its size and the moment it was last used, which is what eviction orders by. */
  private entries = new Map<string, { size: number; at: number }>();
  private bytes = 0;
  // An unwritable folder is a property of the machine, not of one emote: say so once rather than per arrival.
  private warned = false;

  /** `dir` is <settings folder>/emote-cache. The caps are only ever lowered by tests. */
  constructor(
    readonly dir: string,
    private readonly now: () => number = Date.now,
    private readonly limits = { files: CACHE_MAX_FILES, bytes: CACHE_MAX_BYTES },
  ) {}

  /**
   * Adopts what is already on disk, so a restart doesn't re-download every friend's images. mtime is the only use we
   * carried across sessions, so it seeds the order. A folder that can't be read leaves the cache empty.
   */
  async load(): Promise<void> {
    this.entries.clear();
    this.bytes = 0;
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      this.warn('read', err);
      return;
    }
    for (const name of names) {
      const hash = CACHED.exec(name)?.[1];
      if (!hash) continue; // a leftover temp name, or a file from another app
      try {
        const info = await stat(join(this.dir, name));
        if (!info.isFile()) continue;
        this.entries.set(hash, { size: info.size, at: info.mtimeMs });
        this.bytes += info.size;
      } catch {
        continue; // unreadable: treated as absent, and has() drops it too
      }
    }
    await this.evict();
  }

  /** Whether the still for `hash` is here, recording the use. */
  has(hash: string): boolean {
    const entry = this.entries.get(hash);
    if (!entry) return false;
    if (!isFile(join(this.dir, `${hash}.webp`), false)) {
      this.drop(hash, entry.size); // deleted behind our back
      return false;
    }
    entry.at = this.now();
    return true;
  }

  /** Stores a verified still. False when the bytes aren't the image `hash` names, or the folder can't be written. */
  async put(hash: string, bytes: Uint8Array): Promise<boolean> {
    if (!verifyStill(hash, bytes)) return false;
    if (this.entries.has(hash)) return true;
    const path = join(this.dir, `${hash}.webp`);
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(`${path}.tmp`, bytes);
      await renameWithRetry(`${path}.tmp`, path);
    } catch (err) {
      await rm(`${path}.tmp`, { force: true }).catch(() => undefined);
      this.warn('write', err);
      return false;
    }
    this.entries.set(hash, { size: bytes.length, at: this.now() });
    this.bytes += bytes.length;
    await this.evict();
    return true;
  }

  /** Deletes the least recently used files until both caps hold. */
  private async evict(): Promise<void> {
    while (this.entries.size > this.limits.files || this.bytes > this.limits.bytes) {
      let oldest: string | undefined;
      let best = Infinity;
      for (const [hash, entry] of this.entries) {
        if (entry.at < best) {
          best = entry.at;
          oldest = hash;
        }
      }
      if (oldest === undefined) return; // nothing left to give, so the caps can't be met: stop rather than spin
      const entry = this.entries.get(oldest)!;
      this.drop(oldest, entry.size);
      await rm(join(this.dir, `${oldest}.webp`), { force: true }).catch((err: Error) => this.warn('delete', err));
    }
  }

  private drop(hash: string, size: number): void {
    this.entries.delete(hash);
    this.bytes = Math.max(0, this.bytes - size);
  }

  private warn(what: string, err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[emote-cache] ${what} failed, friends' images stay unavailable:`, (err as Error).message);
  }
}
