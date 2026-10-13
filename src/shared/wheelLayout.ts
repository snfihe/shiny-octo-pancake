import { ALL_PINGS, isPingId, type PingId } from './pings';

/**
 * Fewest and most slices a wheel may hold. The count is the wheel array's length — there is no separate setting to keep in
 * step with it — so resizing means editing the array. Only even counts keep the extended slices opposite each other.
 */
export const MIN_WHEEL_SLOTS = 4;
/** A ping may sit on a wheel only once, so the ping pool is the cap. */
export const MAX_PING_WHEEL_SLOTS = ALL_PINGS.length;
export const MAX_EMOTE_WHEEL_SLOTS = 24;

export const wheelSlotOptions = (max: number): number[] =>
  Array.from({ length: Math.floor((max - MIN_WHEEL_SLOTS) / 2) + 1 }, (_, k) => MIN_WHEEL_SLOTS + k * 2);

/** A wheel is MIN_WHEEL_SLOTS..max known pings, each at most once. */
export function isValidWheel(v: unknown, max: number = MAX_PING_WHEEL_SLOTS): v is PingId[] {
  return Array.isArray(v) && v.length >= MIN_WHEEL_SLOTS && v.length <= max
    && v.every(isPingId) && new Set(v).size === v.length;
}

/**
 * The same wheel with `n` slices. Growing fills the new slots from `fills` (the default wheel first, so resetting and then
 * resizing still looks like League's) with items not already on it; shrinking drops the last slices. `fills` can run dry
 * before `n`, since a slice may hold each item only once.
 */
export function resizeWheel<T extends string>(wheel: readonly T[], n: number, fills: readonly T[]): T[] {
  const target = Math.max(MIN_WHEEL_SLOTS, n);
  const next = wheel.slice(0, target);
  const used = new Set(next);
  for (const id of fills) {
    if (next.length >= target) break;
    if (used.has(id)) continue;
    used.add(id);
    next.push(id);
  }
  return next;
}

/** Puts `id` in `slot`. If it is already elsewhere on the wheel, the two slots swap so nothing appears twice. */
export function placeOnSlot<T extends string>(wheel: readonly T[], id: T, slot: number): T[] {
  const from = wheel.indexOf(id);
  if (from >= 0) return swapSlots(wheel, from, slot);
  const next = [...wheel];
  next[slot] = id;
  return next;
}

export function swapSlots<T extends string>(wheel: readonly T[], a: number, b: number): T[] {
  const next = [...wheel];
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}

/** Where a dragged or click-selected item in the wheel editor came from (a ping id, or an emote ref). */
export type WheelSource<T extends string> =
  | { from: 'pool'; id: T }
  | { from: 'slot'; id: T; slot: number }
  | { from: 'center'; id: T };
/** A wheel slot index, or the centre (the trigger + click item). */
export type WheelTarget = number | 'center';
export type WheelPatch<T extends string> = { wheel?: T[]; center?: T };

/** The change for dropping `src` on `target`, or null when nothing changes. */
export function dropPatch<T extends string>(wheel: readonly T[], center: T, src: WheelSource<T>, target: WheelTarget): WheelPatch<T> | null {
  if (target === 'center') return src.id === center ? null : { center: src.id };
  if (src.from === 'slot') return src.slot === target ? null : { wheel: swapSlots(wheel, src.slot, target) };
  return wheel[target] === src.id ? null : { wheel: placeOnSlot(wheel, src.id, target) };
}
