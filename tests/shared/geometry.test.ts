import { describe, expect, it } from 'vitest';
import { WHEEL, iconSizeFor, pickSlice } from '../../src/shared/geometry';

const at = (deg: number, slots: number, r = 150) => {
  // deg measured clockwise from straight up (N), screen y points down
  const rad = ((deg - 90) * Math.PI) / 180;
  return pickSlice(r * Math.cos(rad), r * Math.sin(rad), slots);
};

describe('pickSlice', () => {
  it('maps the 8 compass directions to slices 0..7 clockwise from N', () => {
    expect([0, 45, 90, 135, 180, 225, 270, 315].map((d) => at(d, 8))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('returns -1 inside the dead zone and a slice at its edge', () => {
    expect(pickSlice(0, -(WHEEL.innerR - 1), 8)).toBe(-1);
    expect(pickSlice(0, 0, 8)).toBe(-1);
    expect(pickSlice(0, -WHEEL.innerR, 8)).toBe(0);
  });

  it('splits slices exactly at ±22.5° and wraps around N', () => {
    expect(at(22.4, 8)).toBe(0);
    expect(at(22.6, 8)).toBe(1);
    expect(at(-1, 8)).toBe(0);
    expect(at(-22.6, 8)).toBe(7);
    expect(at(359.9, 8)).toBe(0);
  });

  it('honours a custom dead zone', () => {
    expect(pickSlice(0, -50, 8, 40)).toBe(0);
    expect(pickSlice(0, -30, 8, 40)).toBe(-1);
  });

  it('covers 360° once for any slice count, from N clockwise', () => {
    for (const slots of [4, 6, 12, 24]) {
      const step = 360 / slots;
      expect(Array.from({ length: slots }, (_, i) => at(i * step, slots))).toEqual(
        Array.from({ length: slots }, (_, i) => i),
      );
      expect(at(step / 2 - 0.1, slots)).toBe(0);
      expect(at(step / 2 + 0.1, slots)).toBe(1);
      expect(at(-step / 2 - 0.1, slots)).toBe(slots - 1);
      expect(at(360 - step / 2 - 0.1, slots)).toBe(slots - 1);
    }
  });

  it('returns -1 when there are no slices to pick from', () => {
    expect(pickSlice(0, -150, 0)).toBe(-1);
  });
});

describe('iconSizeFor', () => {
  it('leaves the icons alone while the ring has room for them', () => {
    expect(iconSizeFor(4)).toBe(WHEEL.iconSize);
    expect(iconSizeFor(8)).toBe(WHEEL.iconSize);
    expect(iconSizeFor(12)).toBe(WHEEL.iconSize);
  });

  it('shrinks the icons once their spacing on the ring falls below them', () => {
    expect(iconSizeFor(16)).toBeLessThan(WHEEL.iconSize);
    expect(iconSizeFor(24)).toBeLessThan(iconSizeFor(16));
  });
});
