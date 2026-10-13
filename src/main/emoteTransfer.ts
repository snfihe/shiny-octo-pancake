import { MAX_CHUNKS } from '../shared/roomProtocol';

/**
 * A chunk's base64 has to stay within the 1,000 characters a sealed packet can carry (`roomCrypto.MAX_PACKET` minus the
 * message's own fields), and base64 of 750 bytes is exactly 1,000 characters. Seventeen of them cover the 12,288-byte
 * still cap, which is why `MAX_CHUNKS` is 17.
 */
export const CHUNK_BYTES = 750;
/** One requester's stills stream at this rate on the LAN, where there is no shared bucket to stay inside. */
export const LAN_CHUNKS_PER_SECOND = 20;
/** A relay send is refused unless this many tokens would remain, so pings never queue behind a friend's image. */
export const RELAY_TOKENS_TO_KEEP = 5;

const ASSEMBLIES_MAX = 16;
const ASSEMBLY_BYTES_MAX = 256 * 1024;
/** A queue or an assembly with nothing happening for this long is given up on. */
const IDLE_MS = 60_000;
/** How long to wait for the next chunk before asking again, and how many times to ask. */
const REASK_MS = 3_000;
const REASK_MAX = 3;

/** A request the room must put on the wire. */
export interface Want {
  to: string;
  h: string;
  /** Chunk indexes to re-send; empty asks for all of them. */
  need: number[];
}

/** What a hash's owner needs from us: which indexes are still missing, and to whom we owe them. */
interface Queue {
  n: number;
  /** The indexes asked for and not yet delivered. */
  need: Set<number>;
  /** Who asked, so a LAN unicast reaches each of them and a relay broadcast reaches all at once. */
  to: Set<string>;
  last: number;
}

export interface SenderDeps {
  now(): number;
  /** The still we can serve for `hash`, or null when we no longer have it (removed, or never really had it). */
  read(hash: string): Uint8Array | null;
  /**
   * Hands one chunk out, to all these requesters at once. Who is sent it, over which transport, and how fast, is the
   * caller's business: on a relay one send reaches the whole room, so a chunk is written once however many asked.
   */
  deliver(hash: string, i: number, n: number, b64: string, to: string[]): void;
}

/**
 * Answers `want` for the hashes we announced. One queue per hash: whoever asks for the same image joins it, and a chunk
 * goes out to every requester on that queue. A queue dies when it is served, when its last requester leaves, or when the
 * hash stops being announced.
 */
export class EmoteSender {
  private queues = new Map<string, Queue>();

  constructor(private readonly deps: SenderDeps) {}

  /** A `want` arrived. `h` must be one of our own announcements; anything else is a lie about what we have. */
  want(from: string, h: string, need: number[]): void {
    const queue = this.queues.get(h);
    if (queue) {
      queue.to.add(from);
      this.merge(queue, need);
      queue.last = this.deps.now();
      return;
    }
    const bytes = this.deps.read(h);
    if (!bytes) return;
    const fresh: Queue = { n: Math.ceil(bytes.length / CHUNK_BYTES), need: new Set(), to: new Set([from]), last: this.deps.now() };
    this.merge(fresh, need);
    this.queues.set(h, fresh);
  }

  /** The hash left our announcements, or its last requester went: nothing more to serve. */
  forget(hash: string): void {
    this.queues.delete(hash);
  }

  /** The hashes with a queue, so the caller can drop the ones it no longer announces. */
  hashes(): string[] {
    return [...this.queues.keys()];
  }

  /** Leaving a room: nothing is owed to anyone any more. */
  reset(): void {
    this.queues.clear();
  }

  /** A member left: drop them from queues, and drop the queues nobody waits for. */
  left(peer: string): void {
    for (const [hash, queue] of [...this.queues]) {
      queue.to.delete(peer);
      if (queue.to.size === 0) this.queues.delete(hash);
    }
  }

  /**
   * Sends what is allowed. Called on the room's own tick and right after a `want`, so the first chunk of a request that
   * arrives between two ticks doesn't wait for one.
   */
  pump(): void {
    const now = this.deps.now();
    for (const [hash, queue] of [...this.queues]) {
      if (now - queue.last > IDLE_MS) {
        this.queues.delete(hash);
        continue;
      }
      const requesters = [...queue.to];
      if (requesters.length === 0) {
        this.queues.delete(hash);
        continue;
      }
      const bytes = this.deps.read(hash);
      if (!bytes || Math.ceil(bytes.length / CHUNK_BYTES) !== queue.n) {
        this.queues.delete(hash); // it went away, or it isn't the image we promised
        continue;
      }
      const next = [...queue.need].sort((a, b) => a - b)[0];
      if (next === undefined) {
        this.queues.delete(hash);
        continue;
      }
      const b64 = Buffer.from(bytes.subarray(next * CHUNK_BYTES, (next + 1) * CHUNK_BYTES)).toString('base64');
      queue.need.delete(next);
      queue.last = now;
      this.deps.deliver(hash, next, queue.n, b64, requesters);
    }
  }

  private merge(queue: Queue, need: number[]): void {
    if (need.length === 0) {
      for (let i = 0; i < queue.n; i++) queue.need.add(i);
      return;
    }
    for (const i of need) if (i < queue.n) queue.need.add(i);
  }
}

interface Assembly {
  /** The member that announced this hash: chunks for it come from them, and only from them. */
  from: string;
  n: number;
  parts: Map<number, Uint8Array>;
  bytes: number;
  first: number;
  last: number;
  /** `want`s we have sent for this image, so a stalled transfer is given up on rather than retried forever. */
  asks: number;
}

export interface AssemblerDeps {
  now(): number;
  /** Whether we already have this still, in our own library or in the cache. */
  has(hash: string): boolean;
  /** Stores a completed, verified still. False when the bytes aren't what the hash promised. */
  put(hash: string, bytes: Uint8Array): Promise<boolean>;
}

/**
 * Fetches the stills behind what other members announced, and puts them together as their chunks arrive. It asks once per
 * announcement and re-asks when a transfer stalls, so a lost chunk costs seconds rather than the emote.
 */
export class EmoteAssembler {
  /** peer -> the hashes they announced, which is both our shopping list and our permission to accept their chunks. */
  private announced = new Map<string, Set<string>>();
  private assemblies = new Map<string, Assembly>();
  private total = 0;

  constructor(private readonly deps: AssemblerDeps) {}

  /** Records what a member can serve and returns the `want`s to send for the parts of it we don't have. */
  announcedBy(peer: string, hashes: string[]): Want[] {
    const known = new Set(hashes);
    this.announced.set(peer, known);
    const wants: Want[] = [];
    for (const h of known) {
      if (this.assemblies.has(h) || this.deps.has(h)) continue;
      if (!this.start(peer, h)) continue; // no room to fetch another one right now
      wants.push({ to: peer, h, need: [] });
    }
    // An image another member announced first is no longer this one's to fetch.
    for (const [hash, assembly] of this.assemblies) if (assembly.from === peer && !known.has(hash)) this.assemblies.delete(hash);
    return wants;
  }

  /** Takes a chunk. Chunks are accepted whether or not we asked, so one relay broadcast fills every cache in the room. */
  chunk(from: string, h: string, i: number, n: number, b64: string): void {
    if (!this.announced.get(from)?.has(h)) return; // only the member who announced an image may serve it
    const bytes = decode(b64);
    if (!bytes) return;
    let assembly = this.assemblies.get(h);
    if (!assembly) {
      assembly = this.start(from, h);
      if (!assembly) return;
    }
    if (assembly.n === 0) assembly.n = n; // the first chunk says how many there are: an announcement alone doesn't
    if (assembly.n !== n || i >= n || assembly.parts.has(i)) return;
    assembly.parts.set(i, bytes);
    assembly.bytes += bytes.length;
    assembly.last = this.deps.now();
    this.total += bytes.length;
    if (assembly.parts.size === assembly.n) void this.finish(h, assembly);
  }

  /** A member left: forget their announcements and any image we were still waiting on them for. */
  left(peer: string): void {
    this.announced.delete(peer);
    for (const [hash, assembly] of [...this.assemblies]) if (assembly.from === peer) this.drop(hash, assembly);
  }

  /** Leaving a room: announcements and half-assembled images alike. */
  reset(): void {
    this.announced.clear();
    this.assemblies.clear();
    this.total = 0;
  }

  /** Re-asks for stalled transfers and drops dead ones. Called on the room's tick. */
  tick(): Want[] {
    const now = this.deps.now();
    const wants: Want[] = [];
    for (const [hash, assembly] of [...this.assemblies]) {
      if (now - assembly.first > IDLE_MS) {
        this.drop(hash, assembly);
        continue;
      }
      if (now - assembly.last < REASK_MS) continue;
      if (assembly.asks >= REASK_MAX) {
        this.drop(hash, assembly); // the next presence can try again
        continue;
      }
      assembly.asks++;
      assembly.last = now;
      wants.push({ to: assembly.from, h: hash, need: missing(assembly) });
    }
    return wants;
  }

  private start(peer: string, h: string): Assembly | undefined {
    if (this.assemblies.size >= ASSEMBLIES_MAX || this.total >= ASSEMBLY_BYTES_MAX) {
      const oldest = [...this.assemblies].sort((a, b) => a[1].last - b[1].last)[0];
      if (!oldest || oldest[1].from === peer) return undefined; // nothing spare, and we won't evict the one in flight
      this.drop(oldest[0], oldest[1]);
    }
    const assembly: Assembly = { from: peer, n: 0, parts: new Map(), bytes: 0, first: this.deps.now(), last: this.deps.now(), asks: 0 };
    this.assemblies.set(h, assembly);
    return assembly;
  }

  private drop(hash: string, assembly: Assembly): void {
    this.assemblies.delete(hash);
    this.total -= assembly.bytes;
  }

  private async finish(hash: string, assembly: Assembly): Promise<void> {
    this.drop(hash, assembly);
    const joined = new Uint8Array(assembly.bytes);
    let at = 0;
    for (let i = 0; i < assembly.n; i++) {
      const part = assembly.parts.get(i);
      if (!part) return;
      joined.set(part, at);
      at += part.length;
    }
    await this.deps.put(hash, joined);
  }
}

const missing = (assembly: Assembly): number[] => {
  const out: number[] = [];
  for (let i = 0; i < assembly.n; i++) if (!assembly.parts.has(i)) out.push(i);
  return out.slice(0, MAX_CHUNKS);
};

/** base64 as the wire carries it. The protocol already bounds the characters; this bounds the bytes they decode to. */
function decode(b64: string): Uint8Array | null {
  const bytes = Buffer.from(b64, 'base64');
  return bytes.length > 0 && bytes.length <= CHUNK_BYTES ? new Uint8Array(bytes) : null;
}
