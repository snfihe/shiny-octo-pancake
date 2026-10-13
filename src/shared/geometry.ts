/** Wheel geometry in CSS pixels (matches prototype/wheel-demo.html). */
export const WHEEL = { innerR: 86, outerR: 188, extR: 288, iconR: 137, iconSize: 48 } as const;

/** The widest an icon may be: past a few slices the icons crowd the ring, so they shrink to stay apart. */
export function iconSizeFor(slots: number): number {
  const spacing = 2 * WHEEL.iconR * Math.sin(Math.PI / Math.max(slots, 1));
  return Math.min(WHEEL.iconSize, Math.round(spacing * 0.86));
}

/**
 * Slice under an offset from the wheel centre. Screen coordinates (y down).
 * Returns -1 inside the dead zone, else 0..slots-1 where 0 = N and indices go clockwise.
 * Slices are 360/slots degrees wide, the first centred on N.
 */
export function pickSlice(dx: number, dy: number, slots: number, deadZone: number = WHEEL.innerR): number {
  if (slots < 1 || Math.hypot(dx, dy) < deadZone) return -1;
  const step = 360 / slots;
  const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 90 + step / 2 + 360) % 360;
  return Math.floor(deg / step) % slots;
}
