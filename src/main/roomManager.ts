import { EventEmitter } from 'node:events';
import type { EmoteRef } from '../shared/emotes';
import type { PingId } from '../shared/pings';
import type { JoinResult, MemberPath, RoomMember, RoomStateCore } from '../shared/room';
import { formatRoomCode, makeRoomCode, parseRoomCode } from '../shared/roomCode';
import {
  decodeMessage, encodeMessage, isOlderThan, MAX_ANNOUNCED, PROTOCOL_VERSION,
  type ChunkMsg, type MemberStatus, type PresenceMsg, type RoomMessage, type WantMsg,
} from '../shared/roomProtocol';
import { EmoteAssembler, EmoteSender, LAN_CHUNKS_PER_SECOND, RELAY_TOKENS_TO_KEEP, type Want } from './emoteTransfer';
import { RateLimiter } from './rateLimiter';
import { ReplayGuard } from './replayGuard';
import { open, seal, type RoomKeys } from './roomCrypto';
import type { PeerKey, Transport, TransportStatus } from './transport';

export const MAX_MEMBERS = 8;
const SETTLE_MS = 3000;
/** Relays can take a while to answer: the "room full" check never waits longer than this after joining. */
const SETTLE_CAP_MS = 15_000;
const TICK_MS = 1000;
/** How often presence is re-announced on each transport. */
const PRESENCE_MS: Record<Transport['kind'], number> = { lan: 2000, internet: 10_000 };
/** How long a path counts as alive after the last packet over it. */
const ALIVE_MS: Record<Transport['kind'], number> = { lan: 6000, internet: 25_000 };
/** Silence before a member is dropped: longer once it was heard over the internet, where presence comes every 10 s. */
const DROP_MS: Record<Transport['kind'], number> = { lan: 15_000, internet: 30_000 };
/** Pings and emotes over relays, per sender: one publish reaches everyone, and public relays only tolerate so much (tools/relay-probe). */
export const RELAY_PING_RATE = 5;
export const RELAY_PING_BURST = 10;
/** Presence asked for on a shared transport (a change, a new link, a new member): at most this often. */
const SHARED_PRESENCE_MS = 1000;
/** How often chunk queues are drained: fast enough that a 17-chunk image lands in a few seconds, slow enough to be cheap. */
const CHUNK_PUMP_MS = 250;
/** The first app version that shows emotes. */
const EMOTES_SINCE = '0.5.0';
const UNREACHABLE_MS = 20_000;
const LONELY_MS = 20_000;
const STALE_STRIKES = 3;
/** A housekeeping tick this late means the computer slept: nobody was heard because we weren't listening. */
const SLEEP_GAP_MS = 5000;
/** How long the clock warning stays up after the last stale presence. */
const SKEW_HINT_MS = 30_000;

export interface RemotePing {
  displayId: number;
  x: number;
  y: number;
  id: PingId;
  tag: { name: string; color: number };
}

export interface RemoteEmote {
  displayId: number;
  x: number;
  y: number;
  ref: EmoteRef;
  /** The sender, so their earlier emote can be replaced: everyone has one on screen at a time. */
  peer: string;
  tag: { name: string; color: number };
}

export type RoomToast =
  | { kind: 'joined' | 'left' | 'disconnected'; name: string }
  | { kind: 'joinedRoom'; code: string }
  | { kind: 'full' };

/**
 * The custom-emote side of the room, read on every use so it follows the wheel and the settings: what stills we can
 * serve, where a received one goes, and whether friends' images are wanted at all.
 */
export interface RoomEmotes {
  /** Hashes on our emote wheel and centre whose files we really have. Announced in every presence. */
  announced: string[];
  /** The still we serve for `hash`, or null when we no longer have it. */
  read(hash: string): Uint8Array | null;
  /** Whether we already hold this still, in our own library or in the cache. */
  has(hash: string): boolean;
  /** A verified still from a friend, into the cache. */
  put(hash: string, bytes: Uint8Array): Promise<boolean>;
  /** "Show friends' custom emotes": off means no `want` goes out, chunks are ignored, and their images aren't shown. */
  wanted: boolean;
}

export interface RoomDeps {
  transports: Transport[];
  now(): number;
  randomBytes(n: number): Uint8Array;
  deriveKeys(canonical: string): Promise<RoomKeys>;
  appVersion: string;
  /** Read on every use, so settings changes apply at once. `limit`: incoming pings per second per member, 0 = unlimited. */
  profile(): { name: string; color: number; limit: number };
  /** Display number → where a ping for it lands here, or null to drop it. The hook share mode will replace. */
  resolveTarget(d: number): { displayId: number; width: number; height: number } | null;
  /** What this machine can serve and wants to fetch, for the friends' images that travel through the room. */
  emotes(): RoomEmotes;
}

interface Member {
  peer: string;
  name: string;
  color: number;
  status: MemberStatus;
  needsUpdate: boolean;
  noEmotes: boolean;
  muted: boolean;
  firstSeen: number;
  /** Ever heard over the internet: dropped after the longer silence. */
  viaInternet: boolean;
  /** The hashes this member announced: the custom emotes it can serve. */
  em: string[];
  /** Per transport kind: the address it was last heard from, and when. */
  paths: Partial<Record<Transport['kind'], { key: PeerKey; seenAt: number }>>;
}

const toHex = (b: Uint8Array): string => [...b].map((v) => v.toString(16).padStart(2, '0')).join('');

/**
 * The room: who is in it, what we send, and what we let through. Talks to the network only through transports,
 * which carry sealed packets. Events: 'state' (RoomStateCore), 'remotePing' (RemotePing), 'remoteEmote' (RemoteEmote), 'toast' (RoomToast),
 * 'saveCode' (canonical code | null: what "rejoin last room" should remember).
 */
export class RoomManager extends EventEmitter {
  /** Our peer ID: random per join, since a peer that said bye stays "gone" to the others for their whole session. */
  self: string;
  private phase: RoomStateCore['phase'] = 'idle';
  private code: string | null = null;
  private keys: RoomKeys | null = null;
  /** Bumped on every join and leave, so a join still deriving keys can tell it was cancelled. */
  private session = 0;
  private seq = 0;
  private members = new Map<string, Member>();
  private answered = new Set<PeerKey>();
  /** Per peer ID: stale presences seen, and when the last one came. Never turns into a member. */
  private staleStrikes = new Map<string, { count: number; at: number }>();
  private guard: ReplayGuard;
  private readonly limiter: RateLimiter;
  private paused = false;
  private roomMuted = false;
  private aloneSince: number | null = null;
  private lastPresence: Partial<Record<Transport['kind'], number>> = {};
  private ticker: NodeJS.Timeout | null = null;
  private lastTick = 0;
  /** When we last woke from sleep: members count as heard then, so they get a fresh grace period. */
  private wokeAt = 0;
  private settle: NodeJS.Timeout | null = null;
  /** The settle timer has been cut down from the cap to SETTLE_MS. */
  private settleShort = false;
  private joinedAt = 0;
  private lastState = '';
  private internetAllowed = true;
  /** The transports running for this room: all of them, except the internet one while it isn't allowed. */
  private readonly active = new Set<Transport>();
  private readonly relayCap: RateLimiter;
  /** Chunks per second per requester, where there is no shared bucket to stay inside. */
  private readonly chunkCap: RateLimiter;
  private readonly sender: EmoteSender;
  private readonly assembler: EmoteAssembler;
  private chunkTicker: NodeJS.Timeout | null = null;
  /** The announcements we last sent, so a wheel change re-announces rather than waiting out the presence interval. */
  private lastAnnounced = '';
  /** A presence waiting out SHARED_PRESENCE_MS, per shared transport. */
  private readonly sharedTimers = new Map<Transport, NodeJS.Timeout>();

  constructor(private readonly deps: RoomDeps) {
    super();
    this.self = toHex(deps.randomBytes(8));
    this.guard = new ReplayGuard(deps.now);
    this.limiter = new RateLimiter(deps.now);
    this.relayCap = new RateLimiter(deps.now);
    this.chunkCap = new RateLimiter(deps.now);
    this.sender = new EmoteSender({
      now: deps.now,
      read: (hash) => deps.emotes().read(hash),
      deliver: (hash, i, n, b64, to) => this.deliverChunk(hash, i, n, b64, to),
    });
    this.assembler = new EmoteAssembler({
      now: deps.now,
      has: (hash) => deps.emotes().has(hash),
      put: (hash, bytes) => deps.emotes().put(hash, bytes),
    });
    for (const t of deps.transports) {
      t.on('packet', (peer: PeerKey, packet: Uint8Array) => this.onPacket(t, peer, packet));
      t.on('peerGone', (peer: PeerKey) => this.onPeerGone(t, peer));
      t.on('status', (s: TransportStatus) => {
        // A fresh socket: tell everyone now rather than at the next round. Relays say so per relay, with linkUp.
        if (s === 'ok' && !t.shared) this.announce(t);
        this.checkSettle();
        this.emitState();
      });
      t.on('linkUp', () => this.announce(t));
    }
  }

  async create(): Promise<void> {
    await this.start(makeRoomCode(this.deps.randomBytes(9)));
  }

  async join(text: string): Promise<JoinResult> {
    const parsed = parseRoomCode(text);
    if (!parsed.ok) return parsed;
    return (await this.start(parsed.code)) ? { ok: true } : { ok: false, error: 'failed' };
  }

  /** Leaves the room and forgets it, so it isn't rejoined on the next launch. */
  leave(): void {
    if (this.phase === 'idle') return;
    this.stop();
    this.emit('saveCode', null);
  }

  /** Says bye on the way out, but keeps the code for "rejoin last room". */
  quit(): void {
    if (this.phase !== 'idle') this.stop();
  }

  sendPing(ping: PingId, shared: { d: number; x: number; y: number }): void {
    this.sendShared({ t: 'ping', ping, ...shared });
  }

  sendEmote(e: EmoteRef, shared: { d: number; x: number; y: number }): void {
    this.sendShared({ t: 'emote', e, ...shared });
  }

  /** A ping or an emote: each member gets it over its own route; shared transports get one send, within the relay cap. */
  private sendShared(body: Record<string, unknown>): void {
    if (this.phase === 'idle' || !this.keys || this.paused) return;
    const packet = this.seal(body);
    const sharedRoutes = new Set<Transport>();
    for (const m of this.members.values()) {
      const route = this.route(m);
      if (!route) continue;
      if (route.transport.shared) sharedRoutes.add(route.transport);
      else route.transport.sendTo(route.key, packet);
    }
    for (const t of sharedRoutes) if (this.relayCap.allow(t.kind, RELAY_PING_RATE, RELAY_PING_BURST)) t.broadcast(packet);
  }

  setStatusFlags(f: { paused: boolean; roomMuted: boolean }): void {
    if (f.paused === this.paused && f.roomMuted === this.roomMuted) return;
    this.paused = f.paused;
    this.roomMuted = f.roomMuted;
    this.announce();
    this.emitState();
  }

  muteMember(peer: string, on: boolean): void {
    const m = this.members.get(peer);
    if (!m) return;
    m.muted = on;
    this.emitState();
  }

  /**
   * "Allow internet connections". Turning it off mid-room sends no bye: a bye makes the others ignore our peer ID for
   * their whole session, LAN included. Members only reachable over the internet time out instead.
   */
  setInternetAllowed(on: boolean): void {
    if (on === this.internetAllowed) return;
    this.internetAllowed = on;
    const keys = this.keys;
    if (!keys) return; // idle, or still deriving keys: start() reads the flag
    for (const t of this.deps.transports) {
      if (t.kind !== 'internet') continue;
      if (on) {
        this.active.add(t);
        t.start(keys);
        this.announce(t);
        continue;
      }
      this.active.delete(t);
      this.cancelShared(t);
      t.stop();
      for (const m of this.members.values()) {
        const p = m.paths.internet;
        if (!p) continue;
        this.answered.delete(p.key);
        delete m.paths.internet;
      }
    }
    this.checkSettle();
    this.emitState();
  }

  /** Name or colour changed: tell everyone now. */
  profileChanged(): void {
    this.announce();
    this.emitState();
  }

  state(): RoomStateCore {
    const now = this.deps.now();
    const status = (kind: Transport['kind']): TransportStatus =>
      this.phase === 'idle' ? 'off' : ([...this.active].find((t) => t.kind === kind)?.status ?? 'off');
    const p = this.deps.profile();
    const members: RoomMember[] = this.phase === 'idle' ? [] : [
      { peer: this.self, name: p.name, color: p.color, path: 'lan', status: this.status(), needsUpdate: false, noEmotes: false, muted: false, self: true },
      ...[...this.members.values()].map((m) => ({
        peer: m.peer, name: m.name, color: m.color, path: this.path(m, now), status: m.status,
        needsUpdate: m.needsUpdate, noEmotes: m.noEmotes, muted: m.muted, self: false,
      })),
    ];
    return {
      phase: this.phase,
      code: this.code ? formatRoomCode(this.code) : null,
      members,
      lan: status('lan'),
      internet: status('internet'),
      lonely: this.aloneSince !== null && now - this.aloneSince >= LONELY_MS,
      clockSkew: [...this.staleStrikes.values()].some((s) => s.count >= STALE_STRIKES && now - s.at < SKEW_HINT_MS),
    };
  }

  /** False when the keys couldn't be derived: the room is back to idle. */
  private async start(code: string): Promise<boolean> {
    if (this.phase !== 'idle') this.leave();
    const session = ++this.session;
    this.self = toHex(this.deps.randomBytes(8));
    this.seq = 0;
    this.phase = 'joining';
    this.code = code;
    this.guard = new ReplayGuard(this.deps.now);
    this.aloneSince = this.deps.now();
    this.emitState();
    let keys: RoomKeys;
    try {
      keys = await this.deps.deriveKeys(code);
    } catch {
      if (session === this.session) this.stop();
      return false;
    }
    if (session !== this.session) return true; // left while deriving
    this.keys = keys;
    this.joinedAt = this.lastTick = this.deps.now();
    this.settleShort = false;
    this.settle = setTimeout(() => this.settled(), SETTLE_CAP_MS);
    for (const t of this.deps.transports) if (t.kind !== 'internet' || this.internetAllowed) this.active.add(t);
    for (const t of this.active) t.start(keys);
    this.announce();
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.chunkTicker = setInterval(() => this.pumpChunks(), CHUNK_PUMP_MS);
    this.checkSettle();
    this.emitState();
    return true;
  }

  /**
   * "Room full" is judged 3 s after the relays have answered or given up, so members only reachable over the
   * internet count too; never later than SETTLE_CAP_MS after joining.
   */
  private checkSettle(): void {
    if (this.phase !== 'joining' || !this.settle || this.settleShort) return;
    if ([...this.active].some((t) => t.shared && (t.status === 'off' || t.status === 'starting'))) return;
    this.settleShort = true;
    clearTimeout(this.settle);
    this.settle = setTimeout(() => this.settled(), Math.min(SETTLE_MS, this.joinedAt + SETTLE_CAP_MS - this.deps.now()));
  }

  private settled(): void {
    this.settle = null;
    if (this.members.size >= MAX_MEMBERS) {
      this.stop();
      this.emit('toast', { kind: 'full' } satisfies RoomToast);
      return;
    }
    this.phase = 'active';
    this.emit('saveCode', this.code);
    this.emit('toast', { kind: 'joinedRoom', code: formatRoomCode(this.code!) } satisfies RoomToast);
    this.emitState();
  }

  private stop(): void {
    this.session++;
    if (this.keys) {
      const bye = this.seal({ t: 'bye' });
      for (const t of this.active) this.spread(t, bye);
      for (const t of this.active) t.stop();
    }
    this.active.clear();
    for (const t of [...this.sharedTimers.keys()]) this.cancelShared(t);
    if (this.ticker) clearInterval(this.ticker);
    if (this.chunkTicker) clearInterval(this.chunkTicker);
    if (this.settle) clearTimeout(this.settle);
    this.ticker = this.chunkTicker = this.settle = null;
    this.phase = 'idle';
    this.code = this.keys = null;
    this.members.clear();
    this.sender.reset();
    this.assembler.reset();
    this.chunkCap.clear();
    this.answered.clear();
    this.staleStrikes.clear();
    this.lastPresence = {};
    this.aloneSince = null;
    this.emitState();
  }

  private tick(): void {
    const now = this.deps.now();
    if (now - this.lastTick > SLEEP_GAP_MS) this.wokeAt = now;
    this.lastTick = now;
    for (const [peer, s] of this.staleStrikes) if (now - s.at >= SKEW_HINT_MS) this.staleStrikes.delete(peer);
    for (const m of [...this.members.values()]) {
      const heard = Math.max(...Object.values(m.paths).map((p) => p.seenAt), m.firstSeen, this.wokeAt);
      if (now - heard >= DROP_MS[m.viaInternet ? 'internet' : 'lan']) this.remove(m, 'disconnected');
    }
    for (const t of this.active) {
      if (now - (this.lastPresence[t.kind] ?? 0) >= PRESENCE_MS[t.kind]) this.sendPresence(t);
    }
    this.sendWants(this.assembler.tick());
    this.emitState();
  }

  private onPacket(t: Transport, key: PeerKey, packet: Uint8Array): void {
    if (!this.keys) return;
    const plain = open(this.keys.msgKey, packet);
    const msg = plain && decodeMessage(plain);
    if (!msg || msg.peer === this.self) return;
    const verdict = this.guard.accept(msg.peer, msg.seq, msg.ts);
    if (verdict === 'stale') return this.onStale(msg);
    if (verdict !== 'ok') return;
    this.staleStrikes.delete(msg.peer);

    if (msg.t === 'presence') return this.onPresence(t, key, msg);
    const m = this.members.get(msg.peer);
    if (msg.t === 'bye') {
      this.guard.markGone(msg.peer);
      if (m) this.remove(m, 'left');
      return;
    }
    if (!m) return;
    this.heard(m, t, key);
    // A friend's image is control traffic: it is never shown, so the display gates and the ping budget don't apply to it.
    if (msg.t === 'want') return this.onWant(msg);
    if (msg.t === 'chunk') return this.onChunk(m, msg);
    // Pings and emotes pass the same gates and share one budget per member.
    if (this.paused || this.roomMuted || m.muted || m.needsUpdate) return;
    if (!this.limiter.allow(m.peer, this.deps.profile().limit)) return;
    const target = this.deps.resolveTarget(msg.d);
    if (!target) return;
    const [x, y] = [msg.x * target.width, msg.y * target.height];
    const tag = { name: m.name, color: m.color };
    if (msg.t === 'ping') this.emit('remotePing', { displayId: target.displayId, x, y, id: msg.ping, tag } satisfies RemotePing);
    else this.emit('remoteEmote', { displayId: target.displayId, x, y, ref: msg.e, peer: m.peer, tag } satisfies RemoteEmote);
  }

  private onPresence(t: Transport, key: PeerKey, msg: PresenceMsg): void {
    let m = this.members.get(msg.peer);
    const isNew = !m;
    if (!m) {
      m = {
        peer: msg.peer, name: msg.name, color: msg.color, status: msg.status, needsUpdate: false, noEmotes: false, muted: false,
        firstSeen: this.deps.now(), viaInternet: false, em: [], paths: {},
      };
      this.members.set(m.peer, m);
      this.aloneSince = null;
    }
    m.name = msg.name;
    m.color = msg.color;
    m.status = msg.status;
    m.needsUpdate = msg.proto !== PROTOCOL_VERSION;
    m.noEmotes = isOlderThan(msg.app, EMOTES_SINCE);
    const announced = [...msg.em].sort().join(',');
    const changed = announced !== [...m.em].sort().join(',');
    m.em = msg.em;
    this.heard(m, t, key);
    if (!this.answered.has(key)) {
      this.answered.add(key);
      if (t.shared) this.announce(t); // everyone hears it anyway, so it's an ordinary presence
      else t.sendTo(key, this.presencePacket());
    }
    // What they can serve is a shopping list: ask for the parts of it we don't already have.
    if (changed && this.deps.emotes().wanted) this.sendWants(this.assembler.announcedBy(m.peer, msg.em));
    if (isNew && this.phase === 'active') this.emit('toast', { kind: 'joined', name: m.name } satisfies RoomToast);
    this.emitState();
  }

  /**
   * Packets more than 10 minutes off our clock. Anyone on the network can replay old ones, so they never create,
   * refresh or reach a member; a few presences only raise the room-level clock warning.
   */
  private onStale(msg: RoomMessage): void {
    if (msg.t !== 'presence') return;
    const s = this.staleStrikes.get(msg.peer) ?? { count: 0, at: 0 };
    this.staleStrikes.set(msg.peer, { count: s.count + 1, at: this.deps.now() });
    this.emitState();
  }

  private onPeerGone(t: Transport, key: PeerKey): void {
    for (const m of this.members.values()) if (m.paths[t.kind]?.key === key) delete m.paths[t.kind];
    this.answered.delete(key);
    this.emitState();
  }

  private heard(m: Member, t: Transport, key: PeerKey): void {
    m.paths[t.kind] = { key, seenAt: this.deps.now() };
    if (t.kind === 'internet') m.viaInternet = true;
  }

  private remove(m: Member, kind: 'left' | 'disconnected'): void {
    this.members.delete(m.peer);
    this.limiter.forget(m.peer);
    this.chunkCap.forget(m.peer);
    this.sender.left(m.peer);
    this.assembler.left(m.peer);
    for (const p of Object.values(m.paths)) this.answered.delete(p.key);
    if (this.members.size === 0 && this.phase !== 'idle') this.aloneSince = this.deps.now();
    this.emit('toast', { kind, name: m.name } satisfies RoomToast);
    this.emitState();
  }

  /** LAN while it is alive, else internet, else nothing. */
  private route(m: Member): { transport: Transport; key: PeerKey } | null {
    const now = this.deps.now();
    for (const kind of ['lan', 'internet'] as const) {
      const p = m.paths[kind];
      const transport = [...this.active].find((t) => t.kind === kind);
      if (p && transport && now - p.seenAt < ALIVE_MS[kind]) return { transport, key: p.key };
    }
    return null;
  }

  private path(m: Member, now: number): MemberPath {
    const r = this.route(m);
    if (r) return r.transport.kind;
    return now - m.firstSeen < UNREACHABLE_MS ? 'connecting' : 'unreachable';
  }

  private status(): MemberStatus {
    return this.paused ? 'paused' : this.roomMuted ? 'muted' : 'on';
  }

  private presencePacket(): Buffer {
    const p = this.deps.profile();
    return this.seal({
      t: 'presence', proto: PROTOCOL_VERSION, app: this.deps.appVersion, name: p.name, color: p.color, status: this.status(),
      em: this.ourAnnouncements(),
    });
  }

  /** The custom emotes we can serve, capped at what a presence may carry. */
  private ourAnnouncements(): string[] {
    return this.deps.emotes().announced.slice(0, MAX_ANNOUNCED);
  }

  /**
   * A friend asked for one of our images. Only the member named in `to` answers: over a relay every member hears every
   * want, and the others have nothing to add to it.
   */
  private onWant(msg: WantMsg): void {
    if (msg.to !== this.self) return;
    this.sender.want(msg.peer, msg.h, msg.need);
    this.pumpChunks();
  }

  /** Part of a friend's image. The assembler takes it only from the member that announced that hash. */
  private onChunk(m: Member, msg: ChunkMsg): void {
    if (!this.deps.emotes().wanted) return;
    this.assembler.chunk(m.peer, msg.h, msg.i, msg.n, msg.b);
  }

  private sendWants(wants: Want[]): void {
    for (const w of wants) this.sendWant(w);
  }

  private sendWant(w: Want): void {
    this.sendTo(w.to, this.seal({ t: 'want', to: w.to, h: w.h, need: w.need }));
  }

  /**
   * One chunk, to everyone waiting for it. A relay needs a single publish for them all, and it comes out of the ping
   * budget with most of that budget kept back so a ping never queues behind an image; the LAN unicasts to each requester
   * under its own share of the traffic.
   */
  private deliverChunk(hash: string, i: number, n: number, b64: string, to: string[]): void {
    const packet = this.seal({ t: 'chunk', h: hash, i, n, b: b64 });
    const published = new Set<Transport>();
    for (const peer of to) {
      const m = this.members.get(peer);
      const route = m ? this.route(m) : null;
      if (!m || !route) continue;
      this.heard(m, route.transport, route.key);
      if (route.transport.shared) {
        if (published.has(route.transport)) continue; // one publish already reached them all
        if (!this.relayCap.allow(route.transport.kind, RELAY_PING_RATE, RELAY_PING_BURST, RELAY_TOKENS_TO_KEEP)) continue;
        published.add(route.transport);
        route.transport.broadcast(packet);
      } else if (this.chunkCap.allow(peer, LAN_CHUNKS_PER_SECOND)) {
        route.transport.sendTo(route.key, packet);
      }
    }
  }

  /** One packet straight to one member, over whichever of their routes is alive. */
  private sendTo(peer: string, packet: Buffer): void {
    const m = this.members.get(peer);
    const route = m ? this.route(m) : null;
    if (!m || !route) return;
    if (route.transport.shared) route.transport.broadcast(packet);
    else route.transport.sendTo(route.key, packet);
  }

  /** Serves what friends asked for, and stops serving whatever we no longer announce. */
  private pumpChunks(): void {
    const ours = new Set(this.ourAnnouncements());
    for (const hash of this.sender.hashes()) if (!ours.has(hash)) this.sender.forget(hash);
    this.sender.pump();
  }

  /**
   * Presence on one transport, or on every running one. A shared transport sends at most once a second: the first
   * request goes out at once, later ones in that second become one presence at its end, with the latest state.
   */
  private announce(only?: Transport): void {
    if (!this.keys) return;
    for (const t of only ? [only] : [...this.active]) {
      if (!this.active.has(t)) continue;
      if (!t.shared) {
        this.sendPresence(t);
        continue;
      }
      const wait = (this.lastPresence[t.kind] ?? -Infinity) + SHARED_PRESENCE_MS - this.deps.now();
      if (wait <= 0) this.sendPresence(t);
      else if (!this.sharedTimers.has(t)) {
        this.sharedTimers.set(t, setTimeout(() => {
          this.sharedTimers.delete(t);
          if (this.keys && this.active.has(t)) this.sendPresence(t);
        }, wait));
      }
    }
  }

  private sendPresence(t: Transport): void {
    this.cancelShared(t);
    this.spread(t, this.presencePacket());
    this.lastPresence[t.kind] = this.deps.now();
  }

  private cancelShared(t: Transport): void {
    const timer = this.sharedTimers.get(t);
    if (timer) clearTimeout(timer);
    this.sharedTimers.delete(t);
  }

  /**
   * Broadcast, and on LAN also straight to every member heard there: Wi-Fi broadcast has no retries and some
   * routers filter it, unicast doesn't. Duplicates are dropped by the receiver's replay guard.
   */
  private spread(t: Transport, packet: Uint8Array): void {
    t.broadcast(packet);
    if (t.shared) return; // one send already reached everyone
    for (const m of this.members.values()) {
      const key = m.paths.lan?.key;
      if (key) t.sendTo(key, packet);
    }
  }

  private seal(body: Record<string, unknown>): Buffer {
    const msg = { peer: this.self, seq: ++this.seq, ts: this.deps.now(), ...body } as RoomMessage;
    return seal(this.keys!.msgKey, encodeMessage(msg));
  }

  private emitState(): void {
    const s = this.state();
    const json = JSON.stringify(s);
    if (json === this.lastState) return;
    this.lastState = json;
    this.emit('state', s);
  }
}
