import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { createHash } from 'crypto';
import { envInt } from '../../utils/envNumber';
import { credentialFor, sourceFor } from './trackerSource';
import { generationOf, videoIdFor } from './resume';

const logger = consola.withTag('Jellyfin');

/** Shows this server saw finished, newest first; the shelf moves on from the named episode. */
export async function ownNextUpRows(userUUID: string, profile: string): Promise<NextUpRow[]> {
  const database: any = require('../database');
  const { parseStremioId } = require('./ids');
  const { envInt } = require('../../utils/envNumber');
  const { videoIdAliases } = require('./aliases');

  const since = Date.now() - envInt('JELLYFIN_NEXTUP_OWN_DAYS', 120, 1) * 24 * 60 * 60 * 1000;
  const shows = envInt('JELLYFIN_NEXTUP_OWN_LIMIT', 300, 1);
  const scanCap = envInt('JELLYFIN_OWN_PLAYED_LIMIT', 20000, 100);
  const batch = 500;

  const rows: NextUpRow[] = [];
  const seen = new Set<string>();
  for (let offset = 0; rows.length < shows && offset < scanCap; offset += batch) {
    let records: any[];
    try {
      records = await database.listRecentlyPlayed(userUUID, since, batch, profile, offset);
    } catch {
      return rows;
    }
    for (const r of records) {
      if (rows.length >= shows) break;
      const parsed = parseStremioId(String(r.video_id));
      if (!parsed || parsed.episode === null || parsed.episode === undefined || seen.has(parsed.base)) continue;
      seen.add(parsed.base);
      for (const alias of await videoIdAliases(String(r.video_id))) {
        const base = parseStremioId(alias)?.base;
        if (base) seen.add(base);
      }
      rows.push({
        metaId: parsed.base,
        videoId: String(r.video_id),
        season: parsed.season ?? null,
        episode: parsed.episode,
        mediaType: parsed.idType === 'kitsu' || parsed.idType === 'mal' || parsed.idType === 'anilist' ? 'anime' : 'series',
        lastWatchedAt: Number(r.last_played_at) || Number(r.updated_at) || 0,
      });
    }
    if (records.length < batch) break;
  }
  return rows;
}

export interface NextUpRow {
  metaId: string;
  /** Set when the tracker names the episode exactly, as anime does. */
  videoId: string | null;
  season: number | null;
  episode: number;
  mediaType: 'anime' | 'series';
  lastWatchedAt: number;
  /** When the tracker says the episode airs, where it says. */
  airsAt?: number | null;
}

export interface WatchedSnapshot {
  /** Video ids in the space the meta publishes, e.g. `kitsu:49002:11`. */
  episodes: Set<string>;
  /** Base ids of watched films. */
  movies: Set<string>;
  /** Watched and total episode counts, keyed by every id the series answers to. */
  series: Map<string, { watched: number; total: number; at?: number }>;
  nextUp: NextUpRow[];
  /** Shows the tracker lists as being watched, next episode aired or not. */
  following: Array<{ metaId: string; mediaType: 'anime' | 'series' }>;
  /** When a video was last watched, by video id, where the tracker says. */
  at: Map<string, number>;
  /** Shows the tracker lists as dropped, under every id they answer to. */
  dropped: Set<string>;
  fingerprint: string;
}

const EMPTY: WatchedSnapshot = {
  episodes: new Set(),
  movies: new Set(),
  series: new Map(),
  nextUp: [],
  following: [],
  at: new Map(),
  dropped: new Set(),
  fingerprint: '',
};

// The raw lists live in Redis keyed by the activities digest, the way the
// watched-id lookup already does it, so a refetch happens when Simkl says
// something changed rather than on a timer. Only the hydrated sets are held
// per process, keyed by that same digest.
const hydrated = new LRUCache<string, WatchedSnapshot>({
  max: envInt('JELLYFIN_WATCHED_CACHE_MAX', 200, 1),
  ttl: envInt('JELLYFIN_WATCHED_TTL', 3600, 1) * 1000,
});

// Held under the credential alone: watching something changes the tracker's digest.
const lastGood = new LRUCache<string, WatchedSnapshot>({
  max: envInt('JELLYFIN_WATCHED_CACHE_MAX', 200, 1),
  ttl: envInt('JELLYFIN_WATCHED_STALE_TTL', 24 * 60 * 60, 60) * 1000,
});
const rebuilding = new Set<string>();

function hold(keyHash: string, key: string, snapshot: WatchedSnapshot): void {
  if (!snapshot.episodes.size && !snapshot.movies.size && !snapshot.series.size) return;
  hydrated.set(key, snapshot);
  lastGood.set(keyHash, snapshot);
}

/** The rebuild is asked for with force, or it would find this held snapshot and return it. */
function heldWhileRebuilding(keyHash: string, rebuild: () => Promise<WatchedSnapshot>): WatchedSnapshot | undefined {
  const stale = lastGood.get(keyHash);
  if (!stale || rebuilding.has(keyHash)) return stale;
  rebuilding.add(keyHash);
  void rebuild()
    .catch((error: any) => logger.debug(`Watched snapshot refresh failed: ${error?.message || error}`))
    .finally(() => rebuilding.delete(keyHash));
  return stale;
}

// A failed read is held for a while; a dead token must not pull the library per request.
const failed = new LRUCache<string, string>({
  max: envInt('JELLYFIN_WATCHED_CACHE_MAX', 200, 1),
  ttl: envInt('JELLYFIN_WATCHED_RETRY', 300, 1) * 1000,
});

/** Every id a series might be addressed by, so a lookup needs no id space. */
function seriesKeys(ids: Record<string, any>): string[] {
  const keys: string[] = [];
  if (ids.imdb) keys.push(String(ids.imdb));
  if (ids.kitsu) keys.push(`kitsu:${ids.kitsu}`);
  if (ids.mal) keys.push(`mal:${ids.mal}`);
  if (ids.anilist) keys.push(`anilist:${ids.anilist}`);
  if (ids.tvdb) keys.push(`tvdb:${ids.tvdb}`);
  if (ids.tmdb) keys.push(`tmdb:${ids.tmdb}`);
  return keys;
}

// A dropped show is kept out under the anime spelling the meta may use as well.
async function droppedKeys(ids: Record<string, any>, config: any = {}): Promise<string[]> {
  if (!ids.imdb && !ids.tvdb && ids.tmdb) {
    try {
      const { resolveAllIds } = require('../id-resolver');
      const found = await resolveAllIds(`tmdb:${ids.tmdb}`, 'series', config, {}, ['imdb', 'tvdb']);
      ids = { ...ids, ...(found?.imdbId ? { imdb: found.imdbId } : {}), ...(found?.tvdbId ? { tvdb: found.tvdbId } : {}) };
    } catch {}
  }
  return seriesKeysWithKitsu(ids);
}

function seriesKeysWithKitsu(ids: Record<string, any>): string[] {
  const keys = seriesKeys(ids);
  if (!ids.kitsu) {
    const idMapper: any = require('../id-mapper');
    const mapping = ids.imdb ? idMapper.getMappingByImdbId(String(ids.imdb)) : ids.tvdb ? idMapper.getMappingByTvdbId(Number(ids.tvdb)) : null;
    if (mapping?.kitsu_id) keys.push(`kitsu:${mapping.kitsu_id}`);
  }
  return keys;
}

// `next_to_watch` is `S02E09` for a show and a bare `E6` for anime, which is
// the absolute numbering its own entry uses.
function parseNextToWatch(value: any): { season: number | null; episode: number } | null {
  const text = String(value ?? '').trim();
  const seasoned = /^S(\d+)E(\d+)$/i.exec(text);
  if (seasoned) return { season: Number(seasoned[1]), episode: Number(seasoned[2]) };

  const absolute = /^E(\d+)$/i.exec(text);
  if (absolute) return { season: null, episode: Number(absolute[1]) };

  return null;
}

function collectShow(entry: any, snapshot: WatchedSnapshot, isAnime: boolean): void {
  const ids = entry?.show?.ids ?? {};
  const keys = seriesKeys(ids);

  const metaId = isAnime && ids.kitsu
    ? `kitsu:${ids.kitsu}`
    : (ids.imdb ? String(ids.imdb) : ids.tvdb ? `tvdb:${ids.tvdb}` : null);
  if (metaId && entry?.status === 'watching') {
    snapshot.following.push({ metaId, mediaType: isAnime && ids.kitsu ? 'anime' : 'series' });
  }
  // An older Simkl app is sent `notinteresting` where a newer one gets `dropped`.
  if (entry?.status === 'dropped' || entry?.status === 'notinteresting') for (const key of seriesKeysWithKitsu(ids)) snapshot.dropped.add(key);

  // Simkl names a next episode for every listed show, a planned or dropped one
  // included; only a show being watched belongs on the shelf.
  const next = entry?.status === 'watching' ? parseNextToWatch(entry?.next_to_watch) : null;
  if (next) {
    if (metaId) {
      snapshot.nextUp.push({
        metaId,
        videoId: isAnime && ids.kitsu ? `kitsu:${ids.kitsu}:${next.episode}` : null,
        season: next.season,
        episode: next.episode,
        mediaType: isAnime && ids.kitsu ? 'anime' : 'series',
        lastWatchedAt: Date.parse(entry?.last_watched_at ?? '') || 0,
        airsAt: Date.parse(entry?.next_to_watch_info?.date ?? '') || null,
      });
    }
  }

  const counts = {
    watched: Number(entry?.watched_episodes_count) || 0,
    total: Math.max(0, (Number(entry?.total_episodes_count) || 0) - (Number(entry?.not_aired_episodes_count) || 0)),
    at: Date.parse(entry?.last_watched_at ?? '') || undefined,
  };
  for (const key of keys) snapshot.series.set(key, counts);

  // An anime entry is numbered inside itself, which is how a catalog keyed on
  // kitsu publishes it. The same show keyed on IMDb or TVDB is split into
  // broadcast seasons, and which one a user sees depends on their providers, so
  // a watch is registered under both rather than only the one Simkl counts in.
  const seasoned = [ids.imdb, ids.tvdb ? `tvdb:${ids.tvdb}` : null].filter(Boolean).map(String);
  const absolute = isAnime && ids.kitsu ? `kitsu:${ids.kitsu}` : null;

  if (!seasoned.length && !absolute) return;

  for (const season of Array.isArray(entry?.seasons) ? entry.seasons : []) {
    for (const episode of Array.isArray(season?.episodes) ? season.episodes : []) {
      const number = Number(episode?.number);
      if (!Number.isFinite(number)) continue;
      const watchedAt = Date.parse(episode?.watched_at ?? '') || 0;
      const mark = (videoId: string) => {
        snapshot.episodes.add(videoId);
        if (watchedAt) snapshot.at.set(videoId, watchedAt);
      };

      if (absolute) mark(`${absolute}:${number}`);

      if (!seasoned.length) continue;

      // Anime episodes carry the broadcast numbering the other id spaces use,
      // which is not the numbering the entry counts in.
      const broadcast = episode?.tvdb
        ? { season: Number(episode.tvdb.season), episode: Number(episode.tvdb.episode) }
        : { season: Number(season.number), episode: number };

      if (!Number.isFinite(broadcast.season) || !Number.isFinite(broadcast.episode)) continue;
      for (const base of seasoned) {
        mark(`${base}:${broadcast.season}:${broadcast.episode}`);
      }
    }
  }
}

interface RawSnapshot {
  episodes: string[];
  movies: string[];
  at?: Array<[string, number]>;
  series: Array<[string, { watched: number; total: number; at?: number }]>;
  nextUp: NextUpRow[];
  following?: Array<{ metaId: string; mediaType: 'anime' | 'series' }>;
  dropped?: string[];
}

async function build(accessToken: string): Promise<RawSnapshot> {
  const { fetchSimklAllItems } = require('../../utils/simklUtils');
  const data = await fetchSimklAllItems(accessToken);

  // A failed read is not an empty library. Returning empty here would be cached
  // and served as though nothing had ever been watched, so every tick would
  // disappear until it expired.
  if (!data) throw new Error('The watched library could not be read');

  const snapshot: WatchedSnapshot = {
    episodes: new Set(),
    movies: new Set(),
    series: new Map(),
    nextUp: [],
    following: [],
    at: new Map(),
    dropped: new Set(),
    fingerprint: '',
  };

  for (const entry of Array.isArray(data?.movies) ? data.movies : []) {
    if (entry?.status !== 'completed') continue;
    const ids = entry?.movie?.ids ?? {};
    const at = Date.parse(entry?.last_watched_at ?? '') || 0;
    if (ids.imdb) snapshot.movies.add(String(ids.imdb));
    if (ids.tmdb) snapshot.movies.add(`tmdb:${ids.tmdb}`);
    if (at && ids.imdb) snapshot.at.set(String(ids.imdb), at);
    if (at && ids.tmdb) snapshot.at.set(`tmdb:${ids.tmdb}`, at);
  }

  for (const entry of Array.isArray(data?.shows) ? data.shows : []) collectShow(entry, snapshot, false);
  for (const entry of Array.isArray(data?.anime) ? data.anime : []) collectShow(entry, snapshot, true);

  return {
    episodes: [...snapshot.episodes],
    movies: [...snapshot.movies],
    at: [...snapshot.at],
    series: [...snapshot.series],
    nextUp: snapshot.nextUp.sort((a, b) => b.lastWatchedAt - a.lastWatchedAt),
    following: snapshot.following,
    dropped: [...snapshot.dropped],
  };
}

// MDBList pages its watched history and names an episode by its show's ids and
// a season number, so an anime row needs the same anidb pivot the resume path
// uses before it matches what the meta publishes.
async function buildMdblist(apiKey: string, config: any): Promise<RawSnapshot> {
  const { makeRateLimitedMDBListRequest } = require('../../utils/mdbList');
  const pageSize = envInt('JELLYFIN_WATCHED_PAGE_SIZE', 1000, 1);
  const maxPages = envInt('JELLYFIN_WATCHED_MAX_PAGES', 50, 1);

  const episodes = new Set<string>();
  const movies = new Set<string>();
  const series = new Map<string, { watched: number; total: number; at?: number }>();

  const read = async (mediatype: 'episode' | 'movie'): Promise<any[]> => {
    const collected: any[] = [];
    let cursor = '';

    for (let page = 0; page < maxPages; page += 1) {
      const url =
        `https://api.mdblist.com/sync/watched?mediatype=${mediatype}` +
        `&limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}` +
        `&apikey=${apiKey}`;
      const response = await makeRateLimitedMDBListRequest(url, apiKey, `MDBList watched ${mediatype} page ${page + 1}`);
      const body = response?.data ?? {};
      const batch = mediatype === 'episode' ? body.episodes : body.movies;
      if (!Array.isArray(batch) || !batch.length) break;

      collected.push(...batch);
      cursor = body?.pagination?.next_cursor ?? '';
      if (!cursor) break;
    }

    return collected;
  };

  const movieRows = await read('movie');
  const episodeRows = await read('episode');
  if (!movieRows.length && !episodeRows.length) logger.debug('No watched history on MDBList');

  const at = new Map<string, number>();
  for (const entry of movieRows) {
    const ids = entry?.movie?.ids ?? {};
    const seen = Date.parse(entry?.last_watched_at ?? '') || 0;
    if (ids.imdb) movies.add(String(ids.imdb));
    if (ids.tmdb) movies.add(`tmdb:${ids.tmdb}`);
    if (seen && ids.imdb) at.set(String(ids.imdb), seen);
    if (seen && ids.tmdb) at.set(`tmdb:${ids.tmdb}`, seen);
  }

  const latest = new Map<string, { resolved: any; season: number; number: number; at: number }>();
  for (const entry of episodeRows) {
    const episode = entry?.episode;
    const season = Number(episode?.season);
    const number = Number(episode?.number);
    const ids = episode?.show?.ids ?? {};
    if (!Number.isFinite(season) || !Number.isFinite(number)) continue;

    const resolved = await videoIdFor(ids, season, number, config);
    if (!resolved) continue;

    episodes.add(resolved.videoId);

    const seen = Date.parse(entry?.last_watched_at ?? '') || 0;
    if (seen) at.set(resolved.videoId, seen);
    const counts = series.get(resolved.metaId) ?? { watched: 0, total: 0 };
    counts.watched += 1;
    if (seen && (!counts.at || seen > counts.at)) counts.at = seen;
    series.set(resolved.metaId, counts);

    const held = latest.get(resolved.metaId);
    if (!held || seen > held.at || (seen === held.at && (season > held.season || (season === held.season && number > held.number)))) {
      latest.set(resolved.metaId, { resolved, season, number, at: seen });
    }
  }

  // MDBList names the next episode itself, the one its own app shows. The
  // history seeds it only when that call fails: the last episode watched, from
  // which the shelf moves on.
  const nextUp: NextUpRow[] = [];
  const upNext: any[] = [];
  try {
    const { fetchMDBListUpNext } = require('../../utils/mdbList');
    for (let page = 1; page <= envInt('JELLYFIN_NEXTUP_MDBLIST_PAGES', 5, 1); page++) {
      const batch = await fetchMDBListUpNext(apiKey, page, 100);
      upNext.push(...batch.items);
      if (!batch.hasMore || !batch.items.length) break;
    }
  } catch (error: any) {
    logger.warn(`MDBList up next failed, seeding from history: ${error?.message || error}`);
  }
  for (const item of upNext) {
    const season = Number(item?.next_episode?.season);
    const number = Number(item?.next_episode?.episode);
    if (!Number.isFinite(season) || !Number.isFinite(number)) continue;
    const resolved = await videoIdFor(item?.show?.ids ?? {}, season, number, config);
    if (!resolved) continue;
    const total = Number(item?.progress?.total_episode_count) || 0;
    if (total > 0) {
      const counts = series.get(resolved.metaId) ?? { watched: Number(item?.progress?.watched_episode_count) || 0, total: 0 };
      counts.total = total;
      series.set(resolved.metaId, counts);
    }
    nextUp.push({
      metaId: resolved.metaId,
      videoId: resolved.mediaType === 'anime' ? resolved.videoId : null,
      season: resolved.mediaType === 'anime' ? null : season,
      episode: resolved.mediaType === 'anime' ? Number(String(resolved.videoId).split(':').pop()) : number,
      mediaType: resolved.mediaType,
      lastWatchedAt: Date.parse(item?.last_watched_at ?? '') || 0,
    });
  }
  if (!upNext.length) {
    for (const [metaId, { resolved, season, number, at }] of latest) {
      nextUp.push({
        metaId,
        videoId: resolved.mediaType === 'anime' ? resolved.videoId : null,
        season: resolved.mediaType === 'anime' ? null : season,
        episode: resolved.mediaType === 'anime' ? Number(String(resolved.videoId).split(':').pop()) : number,
        mediaType: resolved.mediaType,
        lastWatchedAt: at,
      });
    }
  }

  const dropped = new Set<string>();
  try {
    for (let offset = 0; offset < maxPages * pageSize; offset += pageSize) {
      const response = await makeRateLimitedMDBListRequest(`https://api.mdblist.com/sync/dropped?limit=${pageSize}&offset=${offset}&apikey=${apiKey}`, apiKey, 'MDBList dropped');
      const shows = Array.isArray(response?.data?.shows) ? response.data.shows : [];
      for (const item of shows) for (const key of seriesKeysWithKitsu(item?.show?.ids ?? {})) dropped.add(key);
      if (shows.length < pageSize) break;
    }
  } catch (error: any) {
    logger.warn(`MDBList dropped shows failed: ${error?.message || error}`);
  }

  return {
    episodes: [...episodes],
    movies: [...movies],
    at: [...at],
    series: [...series],
    nextUp: nextUp.sort((a, b) => b.lastWatchedAt - a.lastWatchedAt),
    // MDBList's Upcoming feed applies its own filters. Preserve every show in
    // watched history so Jellyfin's metadata and caught-up rules decide which
    // personalized shows belong on its Upcoming row.
    following: [...latest.values()].map(({ resolved }) => ({
      metaId: resolved.metaId,
      mediaType: resolved.mediaType,
    })),
    dropped: [...dropped],
  };
}


/**
 * Simkl suspends a client_id for polling the whole library, so a refetch is
 * gated on the activities digest and the snapshot is otherwise served from
 * cache however often a client asks.
 */
async function readWatchedSnapshot(userUUID: string, config: any, force = false): Promise<WatchedSnapshot> {
  const { readsTrackers } = require('./profiles');
  if (!readsTrackers(config)) return EMPTY;

  const service = sourceFor(config);
  if (!service) return EMPTY;

  const credential = credentialFor(config, service);
  if (!credential) return EMPTY;

  if (service === 'mdblist') return mdblistSnapshot(userUUID, credential, config, force);
  if (service === 'publicmetadb') return pmdbSnapshot(userUUID, credential, config, force);
  if (service !== 'simkl') return EMPTY;

  const tokenId = credential;
  if (failed.has(`simkl:${tokenId}`)) return EMPTY;

  try {
    const { getSimklToken, getSimklActivityFingerprint } = require('../../utils/simklUtils');
    const token = await getSimklToken(tokenId);
    if (!token?.access_token) return EMPTY;

    const accessToken = token.access_token;
    const parts = await Promise.all(
      (['movies', 'shows', 'anime'] as const).map((type) =>
        getSimklActivityFingerprint(accessToken, type, 'completed')
      )
    );
    const tokenHash = createHash('sha256').update(accessToken).digest('hex').substring(0, 16);
    const fingerprint = createHash('sha256').update(parts.join('|')).digest('hex').substring(0, 16);

    const key = `${tokenHash}:${fingerprint}`;
    const memo = force ? undefined : hydrated.get(key);
    if (memo) return memo;
    if (!force) {
      const held = heldWhileRebuilding(tokenHash, () => readWatchedSnapshot(userUUID, config, true));
      if (held) return held;
    }

    const { cacheWrapGlobal, classifyResultAllowEmpty } = require('../getCache');
    const raw: RawSnapshot = await cacheWrapGlobal(
      `jellyfin_watched_v4:${key}`,
      () => build(accessToken),
      envInt('JELLYFIN_WATCHED_REDIS_TTL', 24 * 60 * 60, 60),
      { upstream: true, resultClassifier: classifyResultAllowEmpty }
    );

    const snapshot: WatchedSnapshot = {
      episodes: new Set(raw?.episodes ?? []),
      movies: new Set(raw?.movies ?? []),
      at: new Map(raw?.at ?? []),
      series: new Map(raw?.series ?? []),
      nextUp: raw?.nextUp ?? [],
      following: raw?.following ?? [],
      dropped: new Set(raw?.dropped ?? []),
      fingerprint,
    };
    hold(tokenHash, key, snapshot);
    logger.debug(
      `Watched snapshot for ${userUUID}: ${snapshot.episodes.size} episodes, ${snapshot.movies.size} films`
    );
    return snapshot;
  } catch (error: any) {
    failed.set(`simkl:${tokenId}`, String(error?.message || error));
    logger.warn(`Watched snapshot failed: ${error?.message || error}; not read again for ${envInt('JELLYFIN_WATCHED_RETRY', 300, 1)}s`);
    return EMPTY;
  }
}

/** Shows the tracker says are caught up with an episode on the way, as followed shows. */
export async function upcomingFollowed(config: any, days: number): Promise<Array<{ metaId: string; mediaType: 'anime' | 'series' }>> {
  const { readsTrackers } = require('./profiles');
  if (!readsTrackers(config)) return [];
  const apiKey = credentialFor(config, 'mdblist');
  if (!apiKey) return [];

  const { cacheWrapGlobal, classifyResultAllowEmpty } = require('../getCache');
  const keyHash = createHash('sha256').update(apiKey).digest('hex').substring(0, 16);
  try {
    return await cacheWrapGlobal(
      `jellyfin_upcoming_mdblist_v1:${keyHash}:${days}`,
      async () => {
        const { fetchMDBListUpcoming } = require('../../utils/mdbList');
        const out: Array<{ metaId: string; mediaType: 'anime' | 'series' }> = [];
        for (const item of await fetchMDBListUpcoming(apiKey, days)) {
          const season = Number(item?.next_episode?.season);
          const episode = Number(item?.next_episode?.episode);
          if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;
          const resolved = await videoIdFor(item?.show?.ids ?? {}, season, episode, config);
          if (resolved) out.push({ metaId: resolved.metaId, mediaType: resolved.mediaType });
        }
        return out;
      },
      envInt('JELLYFIN_UPCOMING_TTL', 6 * 60 * 60, 60),
      { upstream: true }
    );
  } catch (error: any) {
    logger.warn(`MDBList upcoming failed: ${error?.message || error}`);
    return [];
  }
}

// No activity digest on PublicMetaDB; the newest play and the total stand in.
async function pmdbFingerprint(apiKey: string): Promise<string> {
  const { cacheWrapGlobal, classifyResultAllowEmpty } = require('../getCache');
  const keyHash = createHash('sha256').update(apiKey).digest('hex').substring(0, 16);
  const head = await cacheWrapGlobal(
    `pmdb_watched_head:${keyHash}`,
    async () => {
      const { fetchWatched, fetchDropped } = require('../../utils/publicmetadbUtils');
      const [page, dropped] = await Promise.all([fetchWatched(apiKey, 1, 1), fetchDropped(apiKey, 1, 1).catch(() => ({ items: [], total: 0, totalPages: 0 }))]);
      const first = page.items[0];
      return `${page.total}|${first?.id ?? ''}|${first?.watched_at ?? ''}|${dropped.total}`;
    },
    envInt('PMDB_ACTIVITIES_TTL', 300, 30),
    { upstream: true, resultClassifier: classifyResultAllowEmpty }
  );
  return createHash('sha256').update(String(head)).digest('hex').substring(0, 16);
}

// The newest play of a show seeds Next Up, which moves on from it.
async function buildPmdb(apiKey: string, config: any): Promise<RawSnapshot> {
  const { fetchWatched, fetchDropped } = require('../../utils/publicmetadbUtils');
  const { movieBase } = require('./resume');
  const maxPages = envInt('JELLYFIN_WATCHED_MAX_PAGES', 50, 1);

  const rows: any[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await fetchWatched(apiKey, page, 500);
    rows.push(...result.items);
    if (page >= result.totalPages || !result.items.length) break;
  }
  if (!rows.length) logger.debug('No watched history on PublicMetaDB');

  const episodes = new Set<string>();
  const movies = new Set<string>();
  const seen = new Map<string, number>();
  const series = new Map<string, { watched: number; total: number; at?: number }>();
  const latest = new Map<string, { row: any; at: number }>();
  const followedSince = Date.now() - envInt('JELLYFIN_NEXTUP_OWN_DAYS', 120, 1) * 24 * 60 * 60 * 1000;

  for (const row of rows) {
    if (!row?.tmdb_id) continue;
    const at = Date.parse(row?.watched_at ?? '') || 0;
    if (row.media_type === 'movie') {
      const base = await movieBase(row.tmdb_id, config);
      movies.add(base);
      movies.add(`tmdb:${row.tmdb_id}`);
      if (at) {
        seen.set(base, at);
        seen.set(`tmdb:${row.tmdb_id}`, at);
      }
      continue;
    }
    const season = Number(row?.season);
    const episode = Number(row?.episode);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;
    const resolved = await videoIdFor({ tmdb: row.tmdb_id }, season, episode, config);
    if (!resolved) continue;
    if (episodes.has(resolved.videoId)) continue;
    episodes.add(resolved.videoId);
    if (at) seen.set(resolved.videoId, at);

    const counts = series.get(resolved.metaId) ?? { watched: 0, total: 0 };
    counts.watched += 1;
    series.set(resolved.metaId, counts);

    const held = latest.get(resolved.metaId);
    if (!held || at > held.at) latest.set(resolved.metaId, { row: { ...resolved, season, episode }, at });
  }

  const nextUp: NextUpRow[] = [];
  const following: Array<{ metaId: string; mediaType: 'anime' | 'series' }> = [];
  for (const [metaId, { row, at }] of latest) {
    nextUp.push({
      metaId,
      videoId: row.mediaType === 'anime' ? row.videoId : null,
      season: row.mediaType === 'anime' ? null : row.season,
      episode: row.mediaType === 'anime' ? Number(String(row.videoId).split(':').pop()) : row.episode,
      mediaType: row.mediaType,
      lastWatchedAt: at,
    });
    if (at >= followedSince) following.push({ metaId, mediaType: row.mediaType });
  }

  const dropped = new Set<string>();
  try {
    for (let page = 1; page <= maxPages; page += 1) {
      const result = await fetchDropped(apiKey, page, 100);
      for (const item of result.items) {
        if (item?.tmdb_id && (item?.media_type ?? 'tv') === 'tv') for (const key of await droppedKeys({ tmdb: item.tmdb_id }, config)) dropped.add(key);
      }
      if (page >= result.totalPages || !result.items.length) break;
    }
  } catch (error: any) {
    logger.warn(`PublicMetaDB dropped shows failed: ${error?.message || error}`);
  }

  return {
    episodes: [...episodes],
    movies: [...movies],
    at: [...seen],
    series: [...series],
    nextUp: nextUp.sort((a, b) => b.lastWatchedAt - a.lastWatchedAt),
    following,
    dropped: [...dropped],
  };
}

async function pmdbSnapshot(userUUID: string, apiKey: string, config: any, force = false): Promise<WatchedSnapshot> {
  const keyHash = createHash('sha256').update(apiKey).digest('hex').substring(0, 16);
  if (failed.has(`pmdb:${keyHash}`)) return EMPTY;
  let key: string;
  try {
    key = `${keyHash}:${await pmdbFingerprint(apiKey)}`;
  } catch (error: any) {
    logger.warn(`PublicMetaDB history digest failed: ${error?.message || error}`);
    return EMPTY;
  }

  const memo = force ? undefined : hydrated.get(key);
  if (memo) return memo;
  if (!force) {
    const held = heldWhileRebuilding(keyHash, () => pmdbSnapshot(userUUID, apiKey, config, true));
    if (held) return held;
  }

  try {
    const { cacheWrapGlobal, classifyResultAllowEmpty } = require('../getCache');
    const raw: RawSnapshot = await cacheWrapGlobal(
      `jellyfin_watched_pmdb_v2:${key}`,
      () => buildPmdb(apiKey, config),
      envInt('JELLYFIN_WATCHED_REDIS_TTL', 24 * 60 * 60, 60),
      { upstream: true, resultClassifier: classifyResultAllowEmpty }
    );

    const snapshot: WatchedSnapshot = {
      episodes: new Set(raw?.episodes ?? []),
      movies: new Set(raw?.movies ?? []),
      at: new Map(raw?.at ?? []),
      series: new Map(raw?.series ?? []),
      nextUp: raw?.nextUp ?? [],
      following: raw?.following ?? [],
      dropped: new Set(raw?.dropped ?? []),
      fingerprint: key,
    };
    hold(keyHash, key, snapshot);
    logger.debug(
      `Watched snapshot for ${userUUID} from publicmetadb: ${snapshot.episodes.size} episodes, ${snapshot.movies.size} films`
    );
    return snapshot;
  } catch (error: any) {
    failed.set(`pmdb:${keyHash}`, String(error?.message || error));
    logger.warn(`Watched snapshot from publicmetadb failed: ${error?.message || error}; not read again for ${envInt('JELLYFIN_WATCHED_RETRY', 300, 1)}s`);
    return EMPTY;
  }
}

/**
 * MDBList publishes the same kind of digest Simkl does, and its own docs say to
 * read it before deciding what changed, so the key is those timestamps rather
 * than a clock: a watch marked elsewhere lands on the next request.
 */
async function mdblistFingerprint(apiKey: string): Promise<string> {
  const { cacheWrapGlobal, classifyResultAllowEmpty } = require('../getCache');
  const keyHash = createHash('sha256').update(apiKey).digest('hex').substring(0, 16);

  const activities = await cacheWrapGlobal(
    `mdblist_last_activities:${keyHash}`,
    async () => {
      const { makeRateLimitedMDBListRequest } = require('../../utils/mdbList');
      const response = await makeRateLimitedMDBListRequest(`https://api.mdblist.com/sync/last_activities?apikey=${apiKey}`, apiKey, 'MDBList activities');
      return response?.data ?? {};
    },
    envInt('MDBLIST_ACTIVITIES_TTL', 300, 30),
    { upstream: true }
  );

  // server_time moves on every call and would defeat the whole point.
  const parts = ['watched_at', 'season_watched_at', 'episode_watched_at', 'journal_at', 'dropped_at']
    .map((field) => activities?.[field] ?? '')
    .join('|');

  return createHash('sha256').update(parts).digest('hex').substring(0, 16);
}

async function mdblistSnapshot(userUUID: string, apiKey: string, config: any, force = false): Promise<WatchedSnapshot> {
  const keyHash = createHash('sha256').update(apiKey).digest('hex').substring(0, 16);
  if (failed.has(`mdblist:${keyHash}`)) return EMPTY;
  let key: string;
  try {
    key = `${keyHash}:${await mdblistFingerprint(apiKey)}`;
  } catch (error: any) {
    failed.set(`mdblist:${keyHash}`, String(error?.message || error));
    logger.warn(`MDBList activities failed: ${error?.message || error}; watched state not read again for ${envInt('JELLYFIN_WATCHED_RETRY', 300, 1)}s`);
    return EMPTY;
  }

  const memo = force ? undefined : hydrated.get(key);
  if (memo) return memo;
  if (!force) {
    const held = heldWhileRebuilding(keyHash, () => mdblistSnapshot(userUUID, apiKey, config, true));
    if (held) return held;
  }

  try {
    const { cacheWrapGlobal, classifyResultAllowEmpty } = require('../getCache');
    const raw: RawSnapshot = await cacheWrapGlobal(
      `jellyfin_watched_mdblist_v4:${key}`,
      () => buildMdblist(apiKey, config),
      envInt('JELLYFIN_WATCHED_REDIS_TTL', 24 * 60 * 60, 60),
      { upstream: true, resultClassifier: classifyResultAllowEmpty }
    );

    const snapshot: WatchedSnapshot = {
      episodes: new Set(raw?.episodes ?? []),
      movies: new Set(raw?.movies ?? []),
      at: new Map(raw?.at ?? []),
      series: new Map(raw?.series ?? []),
      nextUp: raw?.nextUp ?? [],
      following: raw?.following ?? [],
      dropped: new Set(raw?.dropped ?? []),
      fingerprint: key,
    };
    hold(keyHash, key, snapshot);
    logger.debug(
      `Watched snapshot for ${userUUID} from mdblist: ${snapshot.episodes.size} episodes, ${snapshot.movies.size} films`
    );
    return snapshot;
  } catch (error: any) {
    failed.set(`mdblist:${keyHash}`, String(error?.message || error));
    logger.warn(`Watched snapshot from mdblist failed: ${error?.message || error}; not read again for ${envInt('JELLYFIN_WATCHED_RETRY', 300, 1)}s`);
    return EMPTY;
  }
}

export async function watchedSnapshot(userUUID: string, config: any): Promise<WatchedSnapshot> {
  const snapshot = await readWatchedSnapshot(userUUID, config);
  if (snapshot.fingerprint) await followTrackerUnmarks(userUUID, config, snapshot);
  const { dropsKeptHere, localDrops } = require('./dropped');
  if (!userUUID || !dropsKeptHere(config)) return snapshot;
  const local: Set<string> = await localDrops(userUUID, config);
  return local.size ? { ...snapshot, dropped: new Set([...snapshot.dropped, ...local]) } : snapshot;
}

const unmarksFollowed = new LRUCache<string, string>({ max: envInt('JELLYFIN_WATCHED_CACHE_MAX', 200, 1) });
const unmarksInFlight = new Map<string, Promise<void>>();

// A title that left the tracker's list since the last read was unmarked there.
async function followTrackerUnmarks(userUUID: string, config: any, snapshot: WatchedSnapshot): Promise<void> {
  const service = sourceFor(config);
  const credential = service ? credentialFor(config, service) : undefined;
  if (!service || !credential) return;

  const { profileKey } = require('./profiles');
  const profile = profileKey(config);
  const source = createHash('sha256').update(`${service}:${credential}`).digest('hex').substring(0, 16);
  const key = `${userUUID}:${profile}:${source}`;
  if (unmarksFollowed.get(key) === snapshot.fingerprint) return;

  const running = unmarksInFlight.get(key);
  if (running) return running;
  const started = (async () => {
    try {
      await reconcileUnmarks(userUUID, profile, service, key, config, snapshot);
      unmarksFollowed.set(key, snapshot.fingerprint);
    } catch (error: any) {
      logger.debug(`Tracker unmarks not followed for ${userUUID}: ${error?.message || error}`);
    } finally {
      unmarksInFlight.delete(key);
    }
  })();
  unmarksInFlight.set(key, started);
  return started;
}

async function reconcileUnmarks(userUUID: string, profile: string, service: string, key: string, config: any, snapshot: WatchedSnapshot): Promise<void> {
  const database: any = require('../database');
  if (!(await database.listPlayedVideoIds(userUUID, 1, profile)).length) return;

  const ids = [...snapshot.episodes, ...snapshot.movies];
  if (!ids.length) return;

  const { readGlobalCache, writeGlobalCache } = require('../getCache');
  const storeKey = `jellyfin_tracker_seen_v1:${key}`;
  const held = await readGlobalCache(storeKey);
  if (held?.fingerprint === snapshot.fingerprint) return;

  if (Array.isArray(held?.ids)) {
    const cleared = await clearUnmarked(userUUID, profile, config, held.ids, Number(held.seenAt) || 0, new Set(ids));
    if (cleared) {
      const { invalidateResume } = require('./resume');
      invalidateResume(userUUID);
      logger.info(`${cleared} title(s) unmarked on ${service} cleared from the playstate of ${userUUID}`);
    }
  }
  await writeGlobalCache(storeKey, { fingerprint: snapshot.fingerprint, seenAt: Date.now(), ids }, envInt('JELLYFIN_TRACKER_SEEN_DAYS', 30, 1) * 24 * 60 * 60);
}

async function clearUnmarked(userUUID: string, profile: string, config: any, before: string[], seenAt: number, current: Set<string>): Promise<number> {
  const gone = before.filter((id) => !current.has(id));
  if (!gone.length) return 0;
  // A list that lost most of itself is a short read, not a user's doing.
  if (gone.length > Math.max(10, before.length / 2)) {
    logger.warn(`Tracker history for ${userUUID} lost ${gone.length} of ${before.length} titles at once; not treated as unmarks`);
    return 0;
  }

  const database: any = require('../database');
  const { parseStremioId } = require('./ids');
  const { videoIdAliases } = require('./aliases');
  let cleared = 0;
  for (const id of gone) {
    const parsed = parseStremioId(id);
    const isEpisode = Boolean(parsed && parsed.episode !== null && parsed.episode !== undefined);
    const spellings = [id, ...(isEpisode ? await videoIdAliases(id) : await movieSpellings(id, config))];
    if (spellings.some((spelling) => current.has(spelling))) continue;

    const rows = [...(await database.getPlaystates(userUUID, spellings, profile)).values()].filter((row: any) => row.played);
    if (!rows.length) continue;
    if (rows.some((row: any) => Number(row.position_ms) > 0 || Number(row.last_played_at) > seenAt)) continue;

    for (const row of rows) {
      await database.upsertPlaystate(userUUID, row.video_id, { positionMs: 0, played: false, lastPlayedAt: null }, profile);
    }
    cleared += 1;
  }
  return cleared;
}

async function movieSpellings(id: string, config: any): Promise<string[]> {
  try {
    const { resolveAllIds } = require('../id-resolver');
    const ids = await resolveAllIds(id, 'movie', config, {}, [id.startsWith('tmdb:') ? 'imdb' : 'tmdb']);
    return [ids?.imdbId, ids?.tmdbId ? `tmdb:${ids.tmdbId}` : null].filter((spelling): spelling is string => Boolean(spelling) && spelling !== id);
  } catch {
    return [];
  }
}

/**
 * A watch reported to this server has already reached the tracker, but the
 * activities digest it is keyed on is cached for minutes, so the snapshot would
 * keep serving the state from before. Dropping the digest lets the next request
 * see the change instead of waiting out the throttle.
 */
async function snapshotSeed(config: any): Promise<string | null> {
  const service = sourceFor(config);
  if (!service || (service !== 'simkl' && service !== 'mdblist' && service !== 'publicmetadb')) return null;
  const credential = credentialFor(config, service);
  if (!credential) return null;
  if (service !== 'simkl') return credential;
  const { getSimklToken } = require('../../utils/simklUtils');
  const token = await getSimklToken(credential);
  return token?.access_token ?? null;
}

export async function applyLocalWatch(
  config: any,
  change: { videoId: string; metaId: string; kind: 'movie' | 'episode'; played: boolean }
): Promise<void> {
  try {
    const seed = await snapshotSeed(config);
    if (!seed) return;
    const keyHash = createHash('sha256').update(seed).digest('hex').substring(0, 16);

    const patch = (snapshot: WatchedSnapshot): void => {
      const set = change.kind === 'movie' ? snapshot.movies : snapshot.episodes;
      const had = set.has(change.videoId);
      if (change.played === had) return;
      if (change.played) {
        set.add(change.videoId);
        snapshot.at.set(change.videoId, Date.now());
      } else {
        set.delete(change.videoId);
        snapshot.at.delete(change.videoId);
      }
      if (change.kind !== 'episode') return;
      const counts = snapshot.series.get(change.metaId);
      if (!counts) return;
      const watched = Math.max(0, Math.min(counts.total, counts.watched + (change.played ? 1 : -1)));
      snapshot.series.set(change.metaId, { ...counts, watched, at: Date.now() });
    };

    const seen = new Set<WatchedSnapshot>();
    const stale = lastGood.get(keyHash);
    if (stale) { patch(stale); seen.add(stale); }
    for (const key of [...hydrated.keys()]) {
      if (!String(key).startsWith(`${keyHash}:`)) continue;
      const snapshot = hydrated.get(key);
      if (snapshot && !seen.has(snapshot)) { patch(snapshot); seen.add(snapshot); }
    }
  } catch (error: any) {
    logger.debug(`Could not apply the local watch to the held snapshot: ${error?.message || error}`);
  }
}

export async function invalidateWatched(config: any): Promise<void> {
  const service = sourceFor(config);
  if (!service || (service !== 'simkl' && service !== 'mdblist' && service !== 'publicmetadb')) return;

  const credential = credentialFor(config, service);
  if (!credential) return;

  try {
    let seed = credential;
    if (service === 'simkl') {
      const { getSimklToken } = require('../../utils/simklUtils');
      const token = await getSimklToken(credential);
      if (!token?.access_token) return;
      seed = token.access_token;
    }

    const keyHash = createHash('sha256').update(seed).digest('hex').substring(0, 16);
    for (const key of [...hydrated.keys()]) {
      if (String(key).startsWith(`${keyHash}:`)) hydrated.delete(key);
    }

    // An upstream key is stored as global:<key>, so it is deleted by name; a
    // pattern with a leading wildcard walked the whole keyspace per watch.
    const name = service === 'simkl'
      ? `simkl-api-last-activities:${keyHash}`
      : service === 'publicmetadb'
        ? `pmdb_watched_head:${keyHash}`
        : `mdblist_last_activities:${keyHash}`;
    const redis: any = require('../redisClient');
    if (redis) await redis.del(`global:${name}`);
  } catch (error: any) {
    logger.debug(`Could not invalidate the watched snapshot: ${error?.message || error}`);
  }
}


export function isWatched(snapshot: WatchedSnapshot, stremioId: string): boolean {
  return snapshot.episodes.has(stremioId) || snapshot.movies.has(stremioId);
}

/**
 * Fills in watch state on items already built. Identity comes back out of the
 * item's own guid, so this stays one pass over a finished list rather than a
 * parameter threaded through every builder.
 */
function airedFrom(videos: any[]): string[] {
  const now = Date.now();
  const dates = videos.some((v: any) => Number(v?.season) !== 0 && Number.isFinite(Date.parse(v?.released ?? v?.firstAired ?? '')));
  return videos
    .filter((v: any) => {
      if (Number(v?.season) === 0) return false;
      const at = Date.parse(v?.released ?? v?.firstAired ?? '');
      if (!Number.isFinite(at)) return !dates;
      return at <= now;
    })
    .map((v: any) => String(v?.id ?? ''))
    .filter(Boolean);
}

const indexBuilding = new Set<string>();

/** A show's aired episode ids from the episode index; null while an unindexed show is indexed off the request. */
async function airedEpisodeIds(userUUID: string, descriptor: any): Promise<string[] | null> {
  const { seriesIndex } = require('./episodeIndex');
  const metaId = String(descriptor.i);
  const indexed = await seriesIndex(userUUID, metaId, { held: true }).catch(() => null);
  if (indexed) return airedFrom(Array.isArray(indexed.videos) ? indexed.videos : []);

  const key = `${userUUID}:${metaId}`;
  if (!indexBuilding.has(key)) {
    indexBuilding.add(key);
    seriesIndex(userUUID, metaId)
      .catch(() => undefined)
      .finally(() => indexBuilding.delete(key));
  }
  return null;
}

const ownPlayedMemo = new LRUCache<string, Set<string>>({
  max: envInt('JELLYFIN_RESUME_CACHE_MAX', 500, 1),
  ttl: envInt('JELLYFIN_RESUME_TTL', 60, 1) * 1000,
});

async function ownPlayedEpisodes(userUUID: string, profile: string): Promise<Set<string>> {
  const key = `${userUUID}:${profile}:${generationOf(userUUID)}`;
  const held = ownPlayedMemo.get(key);
  if (held) return held;
  const played = new Set<string>();
  try {
    const database: any = require('../database');
    const ids = await database.listPlayedVideoIds(userUUID, envInt('JELLYFIN_OWN_PLAYED_LIMIT', 20000, 100), profile);
    for (const id of ids) if (/:\d+:\d+$/.test(id)) played.add(id);
  } catch {
    return played;
  }
  ownPlayedMemo.set(key, played);
  return played;
}

async function playedUnderAnySpelling(videoId: string, snapshot: WatchedSnapshot, ownPlayed: Set<string>): Promise<boolean> {
  if (snapshot.episodes.has(videoId) || ownPlayed.has(videoId)) return true;
  const { videoIdAliases } = require('./aliases');
  for (const alias of await videoIdAliases(videoId)) {
    if (snapshot.episodes.has(alias) || ownPlayed.has(alias)) return true;
  }
  return false;
}

export async function applyWatchedState(
  items: any[],
  snapshot: WatchedSnapshot,
  userUUID?: string,
  profile = '',
  config?: any
): Promise<void> {
  if (!items.length) return;

  const { decodeJellyfinId } = require('./ids');
  const { stremioIdFor } = require('./idsCodec');

  const descriptors = new Map<string, any>();
  await Promise.all(
    items.map(async (item: any) => {
      if (item?.Id && item.UserData) {
        const d = await decodeJellyfinId(String(item.Id));
        if (d) descriptors.set(String(item.Id), d);
      }
    })
  );

  let own = new Map<string, any>();
  if (userUUID) {
    const videoIds = [...descriptors.values()]
      .filter((d) => d.k === 'movie' || d.k === 'episode')
      .map((d) => stremioIdFor(d))
      .filter(Boolean) as string[];
    try {
      const database: any = require('../database');
      const { getPlaystatesAcross } = require('./aliases');
      own = await getPlaystatesAcross(userUUID, videoIds, profile);
    } catch {
      own = new Map();
    }
  }

  const ownPlayed = userUUID && [...descriptors.values()].some((d) => d.k === 'series')
    ? await ownPlayedEpisodes(userUUID, profile)
    : new Set<string>();

  await Promise.all(
    items.map(async (item: any) => {
      const descriptor = descriptors.get(String(item?.Id));
      if (!descriptor) return;

      if (descriptor.k === 'series') {
        const { itemKeys } = require('./dropped');
        if (snapshot.dropped.size && itemKeys(item, String(descriptor.i)).some((key: string) => snapshot.dropped.has(key))) {
          item.UserData = { ...item.UserData, Likes: false };
        }
        const counts = snapshot.series.get(String(descriptor.i)) ?? (ownPlayed.size ? { watched: 0, total: 0 } : null);
        if (!counts) return;
        // The show's aired episodes are the whole, specials and what has not
        // aired left out; a tracker's own counts stand in only when the meta
        // has none. Without either nothing is claimed, since zero unplayed
        // reads as fully watched.
        const aired = userUUID ? await airedEpisodeIds(userUUID, descriptor) : [];
        const total = aired?.length || counts.total;
        if (total <= 0) return;
        const watched = aired?.length
          ? (await Promise.all(aired.map((videoId) => playedUnderAnySpelling(videoId, snapshot, ownPlayed)))).filter(Boolean).length
          : Math.min(counts.watched, total);
        if (!watched && !snapshot.series.has(String(descriptor.i))) return;
        const unplayed = Math.max(0, total - watched);
        item.UserData = {
          ...item.UserData,
          UnplayedItemCount: unplayed,
          Played: unplayed === 0,
          PlayedPercentage: Math.min(100, (watched / total) * 100),
        };
        return;
      }

      const stremioId = stremioIdFor(descriptor);
      if (!stremioId) return;

      const record = own.get(stremioId);
      if (record) {
        const runtime = Number(record.runtime_ms) || Number(item.RunTimeTicks || 0) / 10000;
        const position = Number(record.position_ms) || 0;
        // A position on a finished title is a rewatch under way.
        item.UserData = {
          ...item.UserData,
          Played: Boolean(record.played),
          PlayCount: Number(record.play_count) || 0,
          PlaybackPositionTicks: Math.round(position * 10000),
          PlayedPercentage: position > 0 && runtime > 0 ? (position / runtime) * 100 : record.played ? 100 : 0,
          ...(record.last_played_at ? { LastPlayedDate: new Date(Number(record.last_played_at)).toISOString() } : {}),
        };
        return;
      }

      if (!isWatched(snapshot, stremioId)) return;
      item.UserData = { ...item.UserData, Played: true, PlayCount: 1 };
    })
  );

  if (userUUID && config) {
    const { applyWatchlistState } = require('./watchlist');
    await applyWatchlistState(items, userUUID, config, descriptors).catch((error: any) =>
      logger.debug(`Watchlist state unavailable: ${error?.message || error}`)
    );
  }
}
