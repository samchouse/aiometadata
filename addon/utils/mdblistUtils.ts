import crypto from 'crypto';
// @ts-ignore
import { cacheWrapGlobal, readGlobalCache, writeGlobalCache } from '../lib/getCache';
// @ts-ignore
import { httpGet } from './httpClient';
// @ts-ignore
import { consola } from 'consola';

const logger = consola.withTag('mdblist-utils');

async function fetchMdblistLastActivities(apiKey: string): Promise<any> {
  const url = `https://api.mdblist.com/sync/last_activities?apikey=${apiKey}`;
  const response = await httpGet(url, {
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'AioMetadata/1.0' }
  });
  return response?.data || {};
}

async function lastKnownMdblistWatchedIds(keyHash: string): Promise<{ movieImdbIds: Set<string>, movieTmdbIds: Set<number>, showImdbIds: Set<string>, showTmdbIds: Set<number>, tmdbIds: Set<number>, mdblistIds: Set<string>, showProgress: Record<string, { seen: number, total: number }>, showEpisodes: Record<string, string[]> } | null> {
  try {
    const fingerprint = await readGlobalCache(`mdblist_watched_ids_latest:v2:${keyHash}`);
    const data = fingerprint ? await readGlobalCache(`mdblist_watched_ids:v2:${keyHash}:${fingerprint}`) : null;
    if (!data) return null;
    return {
      movieImdbIds: new Set(data.movieImdbIds || []),
      movieTmdbIds: new Set(data.movieTmdbIds || []),
      showImdbIds: new Set(data.showImdbIds || []),
      showTmdbIds: new Set(data.showTmdbIds || []),
      tmdbIds: new Set(data.tmdbIds || []),
      mdblistIds: new Set(data.mdblistIds || []),
      showProgress: data.showProgress || {},
      showEpisodes: data.showEpisodes || {}
    };
  } catch {
    return null;
  }
}

export async function getMdblistWatchedIds(config: any): Promise<{ movieImdbIds: Set<string>, movieTmdbIds: Set<number>, showImdbIds: Set<string>, showTmdbIds: Set<number>, tmdbIds: Set<number>, mdblistIds: Set<string>, showProgress: Record<string, { seen: number, total: number }>, showEpisodes: Record<string, string[]> } | null> {
  let keyHash: string | null = null;
  try {
    const mdblist = config.apiKeys?.mdblist;
    if (!mdblist) return null;

    keyHash = crypto.createHash('sha256').update(mdblist).digest('hex').substring(0, 16);

    const activitiesCacheKey = `mdblist_activities:${keyHash}`;
    const activities = await cacheWrapGlobal(activitiesCacheKey, async () => {
      return await fetchMdblistLastActivities(mdblist);
    }, 300);

    const watchedAt = activities?.watched_at || '';
    const episodeWatchedAt = activities?.episode_watched_at || '';
    const fingerprint = crypto.createHash('sha256')
      .update(`${watchedAt}:${episodeWatchedAt}`)
      .digest('hex')
      .substring(0, 16);

    const watchedCacheKey = `mdblist_watched_ids:v2:${keyHash}:${fingerprint}`;
    const watchedData = await cacheWrapGlobal(watchedCacheKey, async () => {
      const movieImdbIds: string[] = [];
      const movieTmdbIds: number[] = [];
      const showTmdbIds: number[] = [];
      const tmdbIds: number[] = [];
      const mdblistIds: string[] = [];

      const showAiredMap = new Map<string, number>();
      const showIdsMap = new Map<string, { imdb?: string, tmdb?: number, mdblist?: string }>();
      const showWatchedEpisodes = new Map<string, Set<string>>();

      let offset = 0;
      const limit = 1000;
      let hasMore = true;

      while (hasMore) {
        const url = `https://api.mdblist.com/sync/watched?apikey=${mdblist}&offset=${offset}&limit=${limit}`;
        const response = await httpGet(url, {
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'AioMetadata/1.0' }
        });

        if (response && response.data) {
          const { movies = [], shows = [], episodes = [], pagination } = response.data;

          for (const item of movies) {
            if (item.movie?.ids?.imdb) movieImdbIds.push(item.movie.ids.imdb);
            if (item.movie?.ids?.tmdb) {
              tmdbIds.push(item.movie.ids.tmdb);
              movieTmdbIds.push(item.movie.ids.tmdb);
            }
            if (item.movie?.ids?.mdblist) mdblistIds.push(item.movie.ids.mdblist);
          }

          for (const item of shows) {
            const imdbId = item.show?.ids?.imdb;
            if (imdbId) {
              showAiredMap.set(imdbId, item.show.total_aired_episodes || 0);
              showIdsMap.set(imdbId, item.show.ids);
            }
          }

          for (const item of episodes) {
            const imdbId = item.episode?.show?.ids?.imdb;
            // BTTTR progress deliberately ignores specials.
            const seasonNum = Number(item.episode?.season);
            const episodeNum = Number(item.episode?.number);
            if (imdbId && Number.isFinite(seasonNum) && Number.isFinite(episodeNum) && seasonNum !== 0) {
              if (!showWatchedEpisodes.has(imdbId)) {
                showWatchedEpisodes.set(imdbId, new Set());
              }
              const epKey = `S${seasonNum}E${episodeNum}`;
              showWatchedEpisodes.get(imdbId)?.add(epKey);

              if (!showIdsMap.has(imdbId)) {
                showIdsMap.set(imdbId, item.episode.show.ids);
              }
            }
          }

          hasMore = pagination?.has_more || false;
          offset += limit;
        } else {
          hasMore = false;
        }
      }

      const finalShowImdbIds: string[] = [];
      const showProgress: Record<string, { seen: number, total: number }> = {};
      const showEpisodes: Record<string, string[]> = {};
      for (const [imdbId, watchedSet] of showWatchedEpisodes.entries()) {
        const airedCount = showAiredMap.get(imdbId) || 0;
        const watchedCount = watchedSet.size;
        const ids = showIdsMap.get(imdbId);
        const episodesList = [...watchedSet];
        showEpisodes[imdbId] = episodesList;
        if (ids?.tmdb) {
          showEpisodes[String(ids.tmdb)] = episodesList;
          showEpisodes[`tmdb:${ids.tmdb}`] = episodesList;
        }

        if (airedCount > 0 && watchedCount >= airedCount) {
          finalShowImdbIds.push(imdbId);
          if (ids?.tmdb) {
            tmdbIds.push(ids.tmdb);
            showTmdbIds.push(ids.tmdb);
          }
          if (ids?.mdblist) mdblistIds.push(ids.mdblist);
        } else if (airedCount > 0 && watchedCount > 0) {
          const progress = { seen: watchedCount, total: airedCount };
          showProgress[imdbId] = progress;
          if (ids?.tmdb) {
            showProgress[String(ids.tmdb)] = progress;
            showProgress[`tmdb:${ids.tmdb}`] = progress;
          }
        }
      }

      logger.info(`[Watched IDs] MDBList sync complete: ${movieImdbIds.length} movies, ${finalShowImdbIds.length} shows fully watched.`);
      return {
        movieImdbIds,
        movieTmdbIds,
        showImdbIds: finalShowImdbIds,
        showTmdbIds,
        tmdbIds,
        mdblistIds,
        showProgress,
        showEpisodes
      };
    }, 86400);

    await writeGlobalCache(`mdblist_watched_ids_latest:v2:${keyHash}`, fingerprint, 86400 * 7);

    return {
      movieImdbIds: new Set(watchedData.movieImdbIds),
      movieTmdbIds: new Set(watchedData.movieTmdbIds || []),
      showImdbIds: new Set(watchedData.showImdbIds),
      showTmdbIds: new Set(watchedData.showTmdbIds || []),
      tmdbIds: new Set(watchedData.tmdbIds),
      mdblistIds: new Set(watchedData.mdblistIds),
      showProgress: watchedData.showProgress || {},
      showEpisodes: watchedData.showEpisodes || {}
    };
  } catch (err: any) {
    logger.warn(`[Watched IDs] Error fetching MDBList watched IDs: ${err.message}`);
    const known = keyHash ? await lastKnownMdblistWatchedIds(keyHash) : null;
    if (known) return known;
    return null;
  }
}

/**
 * Instance owners rarely set a key of their own, since MDBList is paid past
 * 1000 calls a day, so in practice the supplied one is what answers.
 */
export function resolveMdblistKey(supplied: unknown): string {
  const value = String(supplied || '').trim();
  return value || process.env.MDBLIST_API_KEY || process.env.BUILT_IN_MDBLIST_API_KEY || '';
}

/** Keyed per api key, so one user's allowance never serves another's request. */
export function mdblistCacheKey(parts: string[], apikey: string): string {
  const fingerprint = crypto.createHash('sha256').update(String(apikey)).digest('hex').slice(0, 16);
  return `mdblist:${parts.join(':')}:${fingerprint}`;
}
