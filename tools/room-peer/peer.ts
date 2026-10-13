// A fake room member for trying rooms with one computer: it announces itself, pings at random spots and prints
// the pings (and, with --emotes, the emotes) it receives. It speaks the real protocol, using the app's own modules.
// With --emote <file.webp> it also announces that image and answers requests for it, so a friend's own picture can be
// seen arriving rather than only the "?" it gets when nobody serves it.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { LanTransport } from '../../src/main/lanTransport';
import { RelayTransport } from '../../src/main/relayTransport';
import { deriveRoomKeys, open, seal } from '../../src/main/roomCrypto';
import { RELAY_PING_RATE } from '../../src/main/roomManager';
import type { Transport } from '../../src/main/transport';
import { EMOTE_CATALOG } from '../../src/shared/emoteCatalog';
import { ALL_PINGS } from '../../src/shared/pings';
import { parseRoomCode } from '../../src/shared/roomCode';
import { decodeMessage, encodeMessage, PROTOCOL_VERSION, type RoomMessage } from '../../src/shared/roomProtocol';

/** The same stride the app serves with, so the app is asked for exactly what it will accept. */
const CHUNK_BYTES = 750;
/** A chunk every 200 ms: a relay sees 5 events a second, which is what relays tolerate. */
const CHUNK_MS = 200;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string', default: 'Bot' },
    color: { type: 'string', default: '4' },
    rate: { type: 'string', default: '1' }, // pings per second; 0 = only listen
    host: { type: 'string', default: '127.0.0.1' }, // where lolPing runs
    port: { type: 'string', default: '47475' }, // this peer's own port (lolPing itself uses 47474)
    display: { type: 'string', default: '1' },
    relay: { type: 'boolean', default: false }, // through the public relays instead of the LAN
    emotes: { type: 'boolean', default: false }, // also send emotes, alternating with the pings
    emote: { type: 'string', default: '' }, // a WebP still to announce and serve to the room
  },
});

const parsed = parseRoomCode(positionals.join(' '));
if (!parsed.ok) {
  console.error('usage: node tools/room-peer/run.mjs PING-XXXXX-XXXXX [--name Bot] [--color 0-7] [--rate 1] [--host 127.0.0.1] [--port 47475] [--display 1] [--relay] [--emotes] [--emote file.webp]');
  process.exit(1);
}

let served: Uint8Array | null = null;
let servedHash = '';
if (values.emote) {
  try {
    served = new Uint8Array(readFileSync(values.emote));
  } catch (err) {
    console.error(`--emote: ${(err as Error).message}`);
    process.exit(1);
  }
  if (!served.length || served.length > 12_288) {
    console.error('--emote: the still has to be between 1 and 12,288 bytes (the app sends a 160 px WebP of that size)');
    process.exit(1);
  }
  servedHash = createHash('sha256').update(served).digest('hex').slice(0, 32);
}

const keys = await deriveRoomKeys(parsed.code);
const peer = randomBytes(8).toString('hex');
let seq = 0;
const packet = (body: Record<string, unknown>): Buffer =>
  seal(keys.msgKey, encodeMessage({ peer, seq: ++seq, ts: Date.now(), ...body } as RoomMessage));
const presence = (): Buffer =>
  packet({
    t: 'presence', proto: PROTOCOL_VERSION, app: 'room-peer', name: values.name, color: Number(values.color), status: 'on',
    em: servedHash ? [servedHash] : [],
  });

const transport: Transport = values.relay
  ? new RelayTransport()
  : new LanTransport({ port: Number(values.port), seeds: [{ host: values.host!, port: 47474 }] });
const label = values.relay ? 'relay' : 'lan';
transport.on('status', (s) => console.log(`[${label}] ${s}`));
/** Chunks of the image we announced, spread over time so the relays see no more than five events a second. */
const serveChunks = (to: string, h: string, need: number[]): void => {
  if (!served || h !== servedHash) return;
  const n = Math.ceil(served.length / CHUNK_BYTES);
  const indexes = (need.length ? need : [...Array(n).keys()]).filter((i) => i < n);
  console.log(`[out] serving ${indexes.length} of ${n} chunks of ${h.slice(0, 8)} to ${to}`);
  indexes.forEach((i, k) => setTimeout(() => {
    transport.broadcast(packet({ t: 'chunk', h, i, n, b: Buffer.from(served!.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)).toString('base64') }));
  }, k * CHUNK_MS));
};

transport.on('packet', (from: string, data: Uint8Array) => {
  const plain = open(keys.msgKey, data);
  const msg = plain && decodeMessage(plain);
  if (!msg || msg.peer === peer) return;
  if (msg.t === 'ping') console.log(`[in] ${msg.ping} on display ${msg.d} at ${msg.x}, ${msg.y} from ${from}`);
  else if (msg.t === 'emote') console.log(`[in] emote ${msg.e} on display ${msg.d} at ${msg.x}, ${msg.y} from ${from}`);
  else if (msg.t === 'presence') console.log(`[in] presence: ${msg.name} (${msg.status})${msg.em.length ? ` serves ${msg.em.map((h) => h.slice(0, 8)).join(',')}` : ''}`);
  else if (msg.t === 'want') {
    console.log(`[in] want ${msg.h.slice(0, 8)} from ${msg.peer}${msg.to === peer ? '' : ' (not mine)'}`);
    if (msg.to === peer) serveChunks(msg.peer, msg.h, msg.need);
  } else if (msg.t === 'chunk') console.log(`[in] chunk ${msg.h.slice(0, 8)} ${msg.i}/${msg.n}`);
  else console.log(`[in] bye from ${msg.peer}`);
});
transport.start(keys);

setInterval(() => transport.broadcast(presence()), values.relay ? 10_000 : 2000);
if (values.relay) transport.on('linkUp', () => transport.broadcast(presence())); // each relay as it comes up
else transport.once('status', () => transport.broadcast(presence()));
let rate = Number(values.rate);
if (values.relay && rate > RELAY_PING_RATE) {
  console.log(`[relay] --rate ${rate} is more than the relays should get; using ${RELAY_PING_RATE}`);
  rate = RELAY_PING_RATE;
}
const spot = (): [number, number] => [0.1 + Math.random() * 0.8, 0.1 + Math.random() * 0.8];
const sendEmote = (e: string): void => {
  const [x, y] = spot();
  transport.broadcast(packet({ t: 'emote', e, d: Number(values.display), x, y }));
  console.log(`[out] emote ${e} at ${x.toFixed(2)}, ${y.toFixed(2)}`);
};
if (rate > 0) {
  let n = 0;
  setInterval(() => {
    // With --emotes every other send is an emote, so the total stays at the ping rate.
    if (values.emotes && n++ % 2) return sendEmote(EMOTE_CATALOG[Math.floor(Math.random() * EMOTE_CATALOG.length)].slug);
    const ping = ALL_PINGS[Math.floor(Math.random() * ALL_PINGS.length)].id;
    const [x, y] = spot();
    transport.broadcast(packet({ t: 'ping', ping, d: Number(values.display), x, y }));
    console.log(`[out] ${ping} at ${x.toFixed(2)}, ${y.toFixed(2)}`);
  }, 1000 / rate);
  // A custom emote: the real one when --emote gave us an image to serve, so the app can come and fetch it; otherwise a
  // made-up hash nobody has, which is exactly what the "?" placeholder is for.
  if (values.emotes) setInterval(() => sendEmote(`c:${servedHash || randomBytes(16).toString('hex')}`), 10_000);
}
console.log(`room-peer "${values.name}" in room ${positionals.join(' ')} over ${values.relay ? 'the relays' : 'the LAN'} — Ctrl+C to leave`);
if (servedHash) console.log(`  announcing and serving c:${servedHash}`);
process.on('SIGINT', () => {
  transport.broadcast(packet({ t: 'bye' }));
  transport.stop();
  void transport.whenClosed().then(() => process.exit(0));
});
