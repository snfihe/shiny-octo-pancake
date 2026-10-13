import type { RoomEmotes } from '../../../src/main/roomManager';

/**
 * A room's custom-emote side for tests: nothing to serve and nothing wanted, so the M1 behaviour (a friend's imported
 * emote shows as the placeholder) is what an unrelated test sees unless it asks for something else.
 */
export const fakeEmotes = (over: Partial<RoomEmotes> = {}): RoomEmotes => ({
  announced: [],
  read: () => null,
  has: () => false,
  put: async () => true,
  wanted: false,
  ...over,
});
