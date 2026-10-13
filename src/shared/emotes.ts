import { DEFAULT_CLICK_EMOTE, DEFAULT_EMOTE_WHEEL, EMOTE_CATALOG, type CatalogEmote } from './emoteCatalog';
import type { Lang } from './i18n';
import { MAX_EMOTE_WHEEL_SLOTS, MIN_WHEEL_SLOTS } from './wheelLayout';

/** A bundled emote's slug, or 'c:' + 32 lower-case hex characters (the hash of an imported emote). */
export type EmoteRef = string;

export interface CustomEmote {
  id: EmoteRef;
  name: string;
  /** Has a `.anim` file besides the still. */
  animated: boolean;
}

/** What an emote looks like on screen. A placeholder stands in for a custom emote whose files are missing. */
export type EmoteArt =
  | { kind: 'bundled'; slug: string }
  | { kind: 'custom'; url: string; animated: boolean }
  | { kind: 'placeholder' };

export type ImportError = 'type' | 'size' | 'animSize' | 'detail' | 'full' | 'duplicate' | 'disk';
/** What the settings renderer sends the main process when importing: the 160 px still and, optionally, the original animation. */
export interface EmoteFile {
  name: string;
  still: Uint8Array;
  anim?: Uint8Array;
}
export type ImportResult = { ok: true; id: EmoteRef } | { ok: false; error: ImportError };

export const MAX_CUSTOM_EMOTES = 24;
export const EMOTE_DURATION_S = 3;
export const CUSTOM_NAME_MAX = 24;
export const STILL_MAX_BYTES = 12_288;
export const STILL_SIDE = 160;
export const STILL_FALLBACK_SIDE = 128;
export const INPUT_MAX_BYTES = 8_388_608;
/** The longest side of a picked image the settings window will decode: a small file can declare billions of pixels. */
export const INPUT_MAX_SIDE = 8192;
export const ANIM_MAX_BYTES = 5_242_880;
export const ANIM_MAX_SIDE = 1024;

const SLUG = /^[a-z0-9_]{1,40}$/;
const CUSTOM = /^c:[0-9a-f]{32}$/;

/** Well-formed, whether or not it exists. Room messages are checked against this before anything looks it up. */
export const isEmoteRefShape = (v: unknown): v is EmoteRef => typeof v === 'string' && (SLUG.test(v) || CUSTOM.test(v));
export const isCustomRef = (v: unknown): v is EmoteRef => typeof v === 'string' && CUSTOM.test(v);

const BY_SLUG: ReadonlyMap<string, CatalogEmote> = new Map(EMOTE_CATALOG.map((e) => [e.slug, e]));

export const catalogEmote = (slug: string): CatalogEmote | undefined => BY_SLUG.get(slug);
export const isBundledEmote = (v: unknown): v is EmoteRef => typeof v === 'string' && BY_SLUG.has(v);
export const customHash = (ref: EmoteRef): string => ref.slice(2);

/** Relative to a renderer page at <root>/<page>/index.html; assets/ is served at <root>/. */
export const emoteAnimUrl = (slug: string): string => `../emotes/${slug}.webp`;
export const emoteIconUrl = (slug: string): string => `../emotes/${slug}.png`;
export const emoteSoundUrl = (slug: string): string => `../emotes/${slug}.ogg`;
/** Imported emotes live in the user's data folder; the lolping:// protocol serves them. */
export const customStillUrl = (hash: string): string => `lolping://emotes/${hash}.webp`;
export const customAnimUrl = (hash: string): string => `lolping://emotes/${hash}.anim`;

/** Every bundled file that has to ship, relative to assets/. */
export function allEmoteAssetFiles(): string[] {
  return EMOTE_CATALOG.flatMap((e) => [`emotes/${e.slug}.webp`, `emotes/${e.slug}.png`, ...(e.hasSound ? [`emotes/${e.slug}.ogg`] : [])]);
}

export function emoteName(ref: EmoteRef, lang: Lang, custom: readonly CustomEmote[]): string {
  const bundled = catalogEmote(ref);
  if (bundled) return lang === 'zh-CN' ? bundled.nameZh : bundled.name;
  return custom.find((c) => c.id === ref)?.name ?? '?';
}

const isKnown = (ref: EmoteRef, custom: readonly CustomEmote[]): boolean =>
  isBundledEmote(ref) || (isCustomRef(ref) && custom.some((c) => c.id === ref));

/**
 * A wheel is MIN_WHEEL_SLOTS..MAX_EMOTE_WHEEL_SLOTS distinct, well-formed refs; its length is how many slices it has.
 * Anything else gives the default wheel. A slot whose emote no longer exists gets that slot's default, or, when the wheel
 * already holds it, a catalog emote that isn't on the wheel — the catalog is bigger than the largest wheel, so there is one.
 */
export function normalizeEmoteWheel(raw: unknown, custom: readonly CustomEmote[]): EmoteRef[] {
  if (!Array.isArray(raw) || raw.length < MIN_WHEEL_SLOTS || raw.length > MAX_EMOTE_WHEEL_SLOTS
    || !raw.every(isEmoteRefShape) || new Set(raw).size !== raw.length) {
    return [...DEFAULT_EMOTE_WHEEL];
  }
  const wheel: EmoteRef[] = [...raw];
  const used = new Set(wheel.filter((ref) => isKnown(ref, custom)));
  for (let i = 0; i < wheel.length; i++) {
    if (isKnown(wheel[i], custom)) continue;
    const preferred = DEFAULT_EMOTE_WHEEL[i];
    const pick = preferred !== undefined && !used.has(preferred) ? preferred : EMOTE_CATALOG.find((e) => !used.has(e.slug))!.slug;
    used.add(pick);
    wheel[i] = pick;
  }
  return wheel;
}

export function normalizeClickEmote(raw: unknown, custom: readonly CustomEmote[]): EmoteRef {
  return isEmoteRefShape(raw) && isKnown(raw, custom) ? raw : DEFAULT_CLICK_EMOTE;
}
