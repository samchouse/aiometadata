import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import redis from '../redisClient';
import { fetchMeta } from './items';

/**
 * What the episode builders read from a series meta, and nothing else, so a
 * shelf that walks many shows does not rebuild each full meta to find one
 * episode. Shaped like the meta so the builders take it unchanged.
 */
export interface SeriesIndex {
  id: string;
  name: string;
  _imdbId?: string;
  _tmdbId?: string | number;
  poster?: string | null;
  background?: string | null;
  logo?: string | null;
  landscapePoster?: string | null;
  app_extras?: { certification?: string | null };
  videos: Array<{
    id: string;
    season: number | null;
    episode: number;
    title?: string;
    overview?: string;
    released?: string | null;
    runtime?: string | number | null;
    thumbnail?: string | null;
  }>;
}

function ttlSeconds(): number {
  return envInt('JELLYFIN_EPISODE_INDEX_TTL', 6 * 60 * 60, 60);
}

const memory = new LRUCache<string, SeriesIndex>({
  max: envInt('JELLYFIN_EPISODE_INDEX_MAX', 1000, 1),
  ttl: ttlSeconds() * 1000,
});

function keyFor(userUUID: string, metaId: string): string {
  return `jf:epx:${userUUID}:${metaId}`;
}

function trim(meta: any): SeriesIndex {
  const videos = Array.isArray(meta?.videos) ? meta.videos : [];
  return {
    id: String(meta.id),
    name: meta.name,
    ...(meta._imdbId ? { _imdbId: String(meta._imdbId) } : {}),
    ...(meta._tmdbId ? { _tmdbId: meta._tmdbId } : {}),
    ...(meta.poster ? { poster: String(meta.poster) } : {}),
    ...(meta.background ? { background: String(meta.background) } : {}),
    ...(meta.logo ? { logo: String(meta.logo) } : {}),
    ...(meta.landscapePoster ? { landscapePoster: String(meta.landscapePoster) } : {}),
    ...(meta.app_extras?.certification ? { app_extras: { certification: meta.app_extras.certification } } : {}),
    videos: videos.map((video: any) => ({
      id: String(video?.id ?? ''),
      season: Number.isInteger(video?.season) ? video.season : null,
      episode: Number(video?.episode),
      ...(video?.title ? { title: video.title } : {}),
      ...(video?.overview ? { overview: video.overview } : {}),
      ...(video?.released ? { released: video.released } : {}),
      ...(video?.runtime ? { runtime: video.runtime } : {}),
      ...(video?.thumbnail ? { thumbnail: video.thumbnail } : {}),
    })),
  };
}

async function build(userUUID: string, metaId: string): Promise<SeriesIndex | null> {
  const meta = await fetchMeta(userUUID, 'series', metaId);
  if (!meta) return null;
  const index = trim(meta);
  memory.set(keyFor(userUUID, metaId), index);
  if (redis) {
    redis.set(keyFor(userUUID, metaId), JSON.stringify(index), 'EX', ttlSeconds()).catch(() => undefined);
  }
  return index;
}

/** The series' episodes as this configuration publishes them; fetched once per TTL. With `held`, only what is already stored. */
export async function seriesIndex(userUUID: string, metaId: string, opts: { held?: boolean } = {}): Promise<SeriesIndex | null> {
  const key = keyFor(userUUID, metaId);
  const held = memory.get(key);
  if (held) return held;
  if (redis) {
    try {
      const stored = await redis.get(key);
      if (stored) {
        const parsed = JSON.parse(stored) as SeriesIndex;
        memory.set(key, parsed);
        return parsed;
      }
    } catch {
      // fall through to a fresh build
    }
  }
  if (opts.held) return null;
  return build(userUUID, metaId);
}

/** Warms the memory copy for many shows in one Redis read; misses are left for seriesIndex to build. */
export async function warmSeriesIndex(userUUID: string, metaIds: string[]): Promise<void> {
  if (!redis) return;
  const wanted = [...new Set(metaIds)].filter((id) => !memory.has(keyFor(userUUID, id)));
  if (!wanted.length) return;
  try {
    const stored: Array<string | null> = await redis.mget(...wanted.map((id) => keyFor(userUUID, id)));
    stored.forEach((value, i) => {
      if (!value) return;
      try {
        memory.set(keyFor(userUUID, wanted[i]), JSON.parse(value) as SeriesIndex);
      } catch {
        // a bad entry is rebuilt on read
      }
    });
  } catch {
    // Redis unavailable: each show is read on its own
  }
}

/** The same, read again from the meta: for an episode the tracker names that the held index lacks. */
export async function refreshSeriesIndex(userUUID: string, metaId: string): Promise<SeriesIndex | null> {
  return build(userUUID, metaId);
}

/** Builds the episode indexes used by Next Up and Upcoming off the request path. */
export async function warmNextUpIndex(userUUID: string, config: any): Promise<number> {
  const { watchedSnapshot, ownNextUpRows } = require('./watched');
  const { watchlistEntries } = require('./watchlist');
  const { profileKey } = require('./profiles');
  const { mapWithConcurrency } = require('../../utils/concurrency');
  const [snapshot, own, listed] = await Promise.all([
    watchedSnapshot(userUUID, config),
    ownNextUpRows(userUUID, profileKey(config)),
    watchlistEntries(userUUID, config),
  ]);
  const rows = [
    ...own,
    ...snapshot.nextUp,
    ...snapshot.following,
    ...listed.filter((row: any) => row.mediaType !== 'movie'),
  ];
  const metaIds = [...new Set(rows.map((row: any) => String(row.metaId)))];
  await warmSeriesIndex(userUUID, metaIds);
  const missing = metaIds.filter((id) => !memory.has(keyFor(userUUID, id)));
  await mapWithConcurrency(missing, envInt('JELLYFIN_SHELF_META_CONCURRENCY', 4, 1), (id: string) => build(userUUID, id).catch(() => null));
  return missing.length;
}
