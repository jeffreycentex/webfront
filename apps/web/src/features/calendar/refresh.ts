import { API } from '@webfront/shared';
import { z } from 'zod';
import { apiFetch, ApiRequestError, isUnreachable } from '@/lib/api';

const refreshResponse = z.object({
  ok: z.boolean(),
  results: z.array(
    z.object({
      feedId: z.string(),
      ok: z.boolean(),
      error: z.string().nullable(),
      events: z.number(),
    }),
  ),
});

export interface RefreshSummary {
  ok: boolean;
  feeds: number;
  events: number;
  /** First per-feed error message, if any (never contains a feed URL). */
  error: string | null;
}

/** Ask the server to refetch one feed (or all). Throws a user-readable Error on failure. */
export async function refreshCalendars(feedId?: string): Promise<RefreshSummary> {
  const path = feedId ? `${API.calendar}/feeds/${feedId}/refresh` : `${API.calendar}/refresh`;
  try {
    const res = await apiFetch(path, { method: 'POST', schema: refreshResponse });
    return {
      ok: res.ok,
      feeds: res.results.length,
      events: res.results.reduce((n, r) => n + r.events, 0),
      error: res.results.find((r) => !r.ok)?.error ?? null,
    };
  } catch (err) {
    if (isUnreachable(err)) throw new Error('The server is not reachable. Try again when online.');
    if (err instanceof ApiRequestError) throw new Error(err.message);
    throw new Error('Could not refresh calendars.');
  }
}
