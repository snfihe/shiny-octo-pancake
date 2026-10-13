import { describe, expect, it } from 'vitest';
import { CHUNK_BYTES, EmoteAssembler, EmoteSender } from '../../src/main/emoteTransfer';

/** A clock the test turns by hand, because every rule here is about time. */
class Clock {
  at = 1_000_000;
  now = (): number => this.at;
  then(ms: number): void {
    this.at += ms;
  }
}

const HASH = 'ab'.repeat(16);
const OTHER = 'cd'.repeat(16);
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const decode = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));
/** An image of `size` bytes, chunked the way the sender chunks it. */
const chunksOf = (size: number): { i: number; n: number; b: string }[] => {
  const image = Uint8Array.from({ length: size }, (_, k) => k % 251);
  const n = Math.ceil(size / CHUNK_BYTES);
  return [...Array(n).keys()].map((i) => ({ i, n, b: b64(image.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)) }));
};

function sender(over: { read?: (hash: string) => Uint8Array | null } = {}) {
  const clock = new Clock();
  const out: { hash: string; i: number; n: number; bytes: Uint8Array; to: string[] }[] = [];
  const s = new EmoteSender({
    now: clock.now,
    read: over.read ?? (() => null),
    deliver: (hash, i, n, b64s, to) => out.push({ hash, i, n, bytes: decode(b64s), to }),
  });
  return { clock, out, s };
}

describe('EmoteSender', () => {
  it('serves nothing for a hash it cannot read', () => {
    const { s, out } = sender();
    s.want('peer-a', HASH, []);
    s.pump();
    expect(out).toEqual([]);
  });

  it('sends one chunk per pump, indexes in order, and covers the whole image', () => {
    const image = Uint8Array.from({ length: 2000 }, (_, k) => k % 251);
    const { s, out, clock } = sender({ read: () => image });
    s.want('peer-a', HASH, []);
    for (let k = 0; k < 3; k++) {
      clock.then(250);
      s.pump();
    }
    expect(out.map((c) => c.i)).toEqual([0, 1, 2]);
    expect(new Set(out.map((c) => c.n))).toEqual(new Set([3]));
    expect(out[0].bytes.length).toBe(CHUNK_BYTES);
    expect(out[2].bytes.length).toBe(2000 - 2 * CHUNK_BYTES);
    expect(out.every((c) => c.to.join() === 'peer-a')).toBe(true);
  });

  it('joins a second requester to the same queue and delivers to both at once', () => {
    const { s, out, clock } = sender({ read: () => new Uint8Array(10) });
    s.want('peer-a', HASH, []);
    clock.then(100);
    s.want('peer-b', HASH, []);
    s.pump();
    expect(out).toHaveLength(1);
    expect(out[0].to.sort()).toEqual(['peer-a', 'peer-b']);
  });

  it('sends only the indexes asked for, and a later ask for the same range does not repeat them', () => {
    const { s, out } = sender({ read: () => new Uint8Array(3 * CHUNK_BYTES) });
    s.want('peer-a', HASH, [2]);
    s.pump();
    s.pump();
    expect(out.map((c) => c.i)).toEqual([2]);
  });

  it('drops a queue when its last requester leaves, and keeps it while one remains', () => {
    const { s, out } = sender({ read: () => new Uint8Array(10) });
    s.want('peer-a', HASH, []);
    s.want('peer-b', HASH, []);
    s.left('peer-a');
    s.pump();
    expect(out[0].to).toEqual(['peer-b']);
    s.left('peer-b');
    out.length = 0;
    s.pump();
    expect(out).toEqual([]);
    expect(s.hashes()).toEqual([]);
  });

  it('gives up on a queue nobody is being served for a minute', () => {
    const { s, out, clock } = sender({ read: () => new Uint8Array(10) });
    s.want('peer-a', HASH, []);
    clock.then(61_000);
    s.pump();
    expect(out).toEqual([]);
    expect(s.hashes()).toEqual([]);
  });

  it('forgets a hash that stopped being announced and clears everything on reset', () => {
    const { s } = sender({ read: () => new Uint8Array(10) });
    s.want('peer-a', HASH, []);
    s.forget(HASH);
    expect(s.hashes()).toEqual([]);
    s.want('peer-a', OTHER, []);
    s.reset();
    expect(s.hashes()).toEqual([]);
  });
});

function assembler(over: { has?: (hash: string) => boolean } = {}) {
  const clock = new Clock();
  const put: { hash: string; bytes: Uint8Array }[] = [];
  const a = new EmoteAssembler({
    now: clock.now,
    has: over.has ?? (() => false),
    put: async (hash, bytes) => {
      put.push({ hash, bytes });
      return true;
    },
  });
  return { clock, put, a };
}

describe('EmoteAssembler', () => {
  it('asks once for each announced hash it does not have, and not for the ones it does', () => {
    const { a } = assembler({ has: (h) => h === OTHER });
    expect(a.announcedBy('peer-a', [HASH, OTHER])).toEqual([{ to: 'peer-a', h: HASH, need: [] }]);
    expect(a.announcedBy('peer-a', [HASH, OTHER])).toEqual([]); // already in flight or already ours
  });

  it('takes chunks in any order, ignores a repeat, and stores the image once', () => {
    const { a, put } = assembler();
    const parts = chunksOf(2000);
    a.announcedBy('peer-a', [HASH]);
    a.chunk('peer-a', HASH, parts[2].i, parts[2].n, parts[2].b);
    a.chunk('peer-a', HASH, parts[0].i, parts[0].n, parts[0].b);
    a.chunk('peer-a', HASH, parts[0].i, parts[0].n, parts[0].b); // a duplicate, from the broadcast and the unicast
    expect(put).toEqual([]);
    a.chunk('peer-a', HASH, parts[1].i, parts[1].n, parts[1].b);
    expect(put).toHaveLength(1);
    expect(put[0].hash).toBe(HASH);
    expect([...put[0].bytes]).toEqual([...Uint8Array.from({ length: 2000 }, (_, k) => k % 251)]);
  });

  it('refuses chunks from anyone who did not announce that hash', () => {
    const { a, put } = assembler();
    const parts = chunksOf(10);
    a.announcedBy('peer-a', [HASH]);
    a.chunk('peer-b', HASH, parts[0].i, parts[0].n, parts[0].b);
    expect(put).toEqual([]);
  });

  it('refuses a chunk whose index is out of range or whose total disagrees with the one in flight', () => {
    const { a, put } = assembler();
    const parts = chunksOf(2000);
    a.announcedBy('peer-a', [HASH]);
    a.chunk('peer-a', HASH, 9, parts[0].n, parts[0].b);
    a.chunk('peer-a', HASH, parts[0].i, 4, parts[0].b);
    expect(put).toEqual([]);
  });

  it('re-asks for the indexes still missing after three seconds, at most three times, then waits for the next presence', () => {
    const { a, clock } = assembler();
    const parts = chunksOf(3 * CHUNK_BYTES);
    a.announcedBy('peer-a', [HASH]);
    a.chunk('peer-a', HASH, 0, 3, parts[0].b);
    clock.then(3_000);
    expect(a.tick()).toEqual([{ to: 'peer-a', h: HASH, need: [1, 2] }]);
    clock.then(3_000);
    expect(a.tick().length).toBe(1);
    clock.then(3_000);
    expect(a.tick().length).toBe(1);
    expect(a.tick()).toEqual([]); // three asks is enough
  });

  it('drops an assembly that has been silent for a minute', () => {
    const { a, clock } = assembler();
    const parts = chunksOf(2000);
    a.announcedBy('peer-a', [HASH]);
    a.chunk('peer-a', HASH, 0, parts[0].n, parts[0].b);
    clock.then(61_000);
    expect(a.tick()).toEqual([]);
    a.chunk('peer-a', HASH, 1, parts[1].n, parts[1].b);
    a.chunk('peer-a', HASH, 2, parts[2].n, parts[2].b);
    // It started over from the first chunk, so the image is whole again only after a fresh ask.
    expect(a.tick()).toEqual([]);
  });

  it('holds at most sixteen images, making room for another member’s but not for more from the same one', () => {
    const { a, clock } = assembler();
    const hashes = Array.from({ length: 16 }, (_, k) => k.toString(16).padStart(32, '0'));
    expect(a.announcedBy('peer-a', hashes)).toHaveLength(16);
    // peer-a owns every slot and is the only announcer, so a seventeenth waits for the next presence.
    expect(a.announcedBy('peer-a', ['ff'.repeat(16)])).toEqual([]);
    clock.then(10);
    expect(a.announcedBy('peer-b', ['ee'.repeat(16)]).map((w) => w.h)).toEqual(['ee'.repeat(16)]);
  });

  it('stops a member’s transfers when they leave', () => {
    const { a, put } = assembler();
    const parts = chunksOf(2000);
    a.announcedBy('peer-a', [HASH]);
    a.chunk('peer-a', HASH, 0, parts[0].n, parts[0].b);
    a.left('peer-a');
    a.chunk('peer-a', HASH, 1, parts[1].n, parts[1].b);
    a.chunk('peer-a', HASH, 2, parts[2].n, parts[2].b);
    expect(put).toEqual([]);
  });

  it('starts a new assembly from a chunk that arrives before any ask', () => {
    // One relay broadcast reaches everyone, so a member that never asked still fills its cache.
    const { a, put } = assembler();
    const parts = chunksOf(10);
    a.announcedBy('peer-a', [HASH]);
    a.chunk('peer-a', HASH, 0, parts[0].n, parts[0].b);
    expect(put[0].bytes.length).toBe(10);
  });
});
