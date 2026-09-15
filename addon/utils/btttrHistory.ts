type WatchedIds = {
  movieImdbIds: Set<string>;
  movieTmdbIds: Set<string>;
  showImdbIds: Set<string>;
  showTmdbIds: Set<string>;
  showProgress: Map<string, { seen: number; total: number }>;
  showEpisodes: Map<string, Set<string>>;
  anilistIds: Set<number>;
  malIds: Set<number>;
};

interface BtttrCacheEntry {
  expiresAt: number;
  data: WatchedIds;
}

const btttrMemoryCache = new Map<string, BtttrCacheEntry>();
const btttrInFlight = new Map<string, Promise<WatchedIds>>();
const BTTTR_CACHE_TTL_MS = 60 * 1000; // 60 seconds

function buildBtttrCacheKey(config: any): string {
  return [
    config?.userUUID || '',
    config?.apiKeys?.traktTokenId || '',
    config?.apiKeys?.simklTokenId || '',
    config?.apiKeys?.mdblist || '',
    config?.apiKeys?.publicmetadb || '',
    config?.apiKeys?.anilistTokenId || '',
  ].join(':');
}

export function clearBtttrHistoryCache(keyOrConfig?: any): void {
  if (!keyOrConfig) {
    btttrMemoryCache.clear();
    return;
  }
  const key = typeof keyOrConfig === 'string' ? keyOrConfig : buildBtttrCacheKey(keyOrConfig);
  btttrMemoryCache.delete(key);
}

/**
 * Reuse the same snapshots as Hide Watched. They are cached and activity-aware.
 * A completed title wins. Otherwise normal-season episode records are merged,
 * so an older tracker remains useful while active tracking adds new history.
 */
export async function getBtttrHistory(config: any): Promise<WatchedIds> {
  const empty: WatchedIds = {
    movieImdbIds: new Set(),
    movieTmdbIds: new Set(),
    showImdbIds: new Set(),
    showTmdbIds: new Set(),
    showProgress: new Map(),
    showEpisodes: new Map(),
    anilistIds: new Set(),
    malIds: new Set(),
  };

  const hasTrackers = Boolean(
    config?.apiKeys?.traktTokenId ||
    config?.apiKeys?.simklTokenId ||
    config?.apiKeys?.mdblist ||
    config?.apiKeys?.publicmetadb ||
    config?.apiKeys?.anilistTokenId
  );
  if (!hasTrackers) return empty;

  const now = Date.now();
  const cacheKey = buildBtttrCacheKey(config);

  const cached = btttrMemoryCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const existingInFlight = btttrInFlight.get(cacheKey);
  if (existingInFlight) {
    return existingInFlight;
  }

  const fetchPromise = (async () => {
    try {
      const reads: Array<Promise<any>> = [];

      if (config?.apiKeys?.traktTokenId) {
        const { getTraktWatchedIds } = require('./traktUtils');
        reads.push(getTraktWatchedIds(config));
      }
      if (config?.apiKeys?.simklTokenId) {
        const { getSimklWatchedIds } = require('./simklUtils');
        reads.push(getSimklWatchedIds(config));
      }
      if (config?.apiKeys?.mdblist) {
        const { getMdblistWatchedIds } = require('./mdblistUtils');
        reads.push(getMdblistWatchedIds(config));
      }
      if (config?.apiKeys?.publicmetadb) {
        const { getPublicmetadbWatchedIds } = require('./publicmetadbUtils');
        reads.push(getPublicmetadbWatchedIds(config));
      }
      if (config?.apiKeys?.anilistTokenId) {
        const { getAnilistWatchedIds } = require('./anilistUtils');
        reads.push(getAnilistWatchedIds(config));
      }

      if (!reads.length) return empty;

  const settled = await Promise.allSettled(reads);
  for (const result of settled) {
    if (result.status !== 'fulfilled' || !result.value) continue;
    for (const id of result.value.movieImdbIds || []) empty.movieImdbIds.add(String(id));
    for (const id of result.value.movieTmdbIds || []) empty.movieTmdbIds.add(String(id));
    for (const id of result.value.showImdbIds || []) empty.showImdbIds.add(String(id));
    for (const id of result.value.showTmdbIds || []) empty.showTmdbIds.add(String(id));
    for (const id of result.value.anilistIds || []) empty.anilistIds.add(Number(id));
    for (const id of result.value.malIds || []) empty.malIds.add(Number(id));

    // Handle MDBList legacy tmdbIds if movieTmdbIds / showTmdbIds were not present
    if (result.value.tmdbIds && !result.value.movieTmdbIds && !result.value.showTmdbIds) {
      for (const id of result.value.tmdbIds) {
        empty.movieTmdbIds.add(String(id));
        empty.showTmdbIds.add(String(id));
      }
    }

    for (const [id, episodes] of Object.entries(result.value.showEpisodes || {})) {
      const target = empty.showEpisodes.get(id) || new Set<string>();
      for (const episode of episodes as string[]) target.add(String(episode));
      empty.showEpisodes.set(id, target);
    }
    for (const [id, progress] of Object.entries(result.value.showProgress || {})) {
      const seen = Number((progress as any)?.seen);
      const total = Number((progress as any)?.total);
      if (!Number.isFinite(seen) || !Number.isFinite(total) || seen <= 0 || total <= 0) continue;
      const existing = empty.showProgress.get(id);
      // Trackers can overlap. They report the same episodes through different
      // APIs, so summing would double-count them. Keep the furthest progress.
      if (!existing || seen > existing.seen || (seen === existing.seen && total > existing.total)) {
        empty.showProgress.set(id, { seen, total });
      }
    }
  }

  // Cross-map AniList and MAL watched anime to IMDb / TMDB
  if (empty.anilistIds.size || empty.malIds.size) {
    try {
      const idMapper = require('../lib/id-mapper');
      for (const anilistId of empty.anilistIds) {
        const mapping = idMapper.getMappingByAnilistId(anilistId);
        if (mapping) {
          const isMovie = idMapper.mappingIsType?.(mapping, 'movie') || mapping.themoviedb_type === 'movie';
          if (mapping.imdb_id) {
            const imdb = String(mapping.imdb_id).trim();
            if (imdb) (isMovie ? empty.movieImdbIds : empty.showImdbIds).add(imdb.startsWith('tt') ? imdb : `tt${imdb}`);
          }
          if (mapping.themoviedb_id) {
            const tmdb = String(mapping.themoviedb_id).trim();
            if (tmdb) (isMovie ? empty.movieTmdbIds : empty.showTmdbIds).add(tmdb);
          }
        }
      }
      for (const malId of empty.malIds) {
        const mapping = idMapper.getMappingByMalId(malId);
        if (mapping) {
          const isMovie = idMapper.mappingIsType?.(mapping, 'movie') || mapping.themoviedb_type === 'movie';
          if (mapping.imdb_id) {
            const imdb = String(mapping.imdb_id).trim();
            if (imdb) (isMovie ? empty.movieImdbIds : empty.showImdbIds).add(imdb.startsWith('tt') ? imdb : `tt${imdb}`);
          }
          if (mapping.themoviedb_id) {
            const tmdb = String(mapping.themoviedb_id).trim();
            if (tmdb) (isMovie ? empty.movieTmdbIds : empty.showTmdbIds).add(tmdb);
          }
        }
      }
    } catch {}
  }

      if (btttrMemoryCache.size > 200) {
        for (const [k, v] of btttrMemoryCache.entries()) {
          if (v.expiresAt <= now) btttrMemoryCache.delete(k);
        }
      }
      btttrMemoryCache.set(cacheKey, {
        expiresAt: Date.now() + BTTTR_CACHE_TTL_MS,
        data: empty,
      });

      return empty;
    } finally {
      btttrInFlight.delete(cacheKey);
    }
  })();

  btttrInFlight.set(cacheKey, fetchPromise);
  return fetchPromise;
}

export function btttrHistoryValue(ids: any, type: string, history: WatchedIds): string {
  let imdbId = String(ids?.imdbId || ids?.imdb || '').trim();
  let rawTmdb = ids?.tmdbId || ids?.tmdb || '';
  let tmdbId = rawTmdb ? String(rawTmdb).trim() : '';

  // Recover canonical show/movie ID if dealing with dynamic upnext ID
  const rawId = String(ids?.id || '').trim();
  if ((!imdbId && !tmdbId) && rawId) {
    let canonicalId: string | null = rawId;
    if (rawId.includes('upnext_') || rawId.includes('pmdb_resume_')) {
      try {
        const { extractCanonicalIdFromDynamicUpNextId } = require('./metaIds');
        canonicalId = extractCanonicalIdFromDynamicUpNextId(type === 'movie' ? 'movie' : 'series', rawId);
      } catch {}
    }
    if (canonicalId) {
      if (canonicalId.startsWith('tt')) imdbId = canonicalId;
      else if (canonicalId.startsWith('tmdb:')) tmdbId = canonicalId.slice(5);
    }
  }

  let wikiMapper: any = null;
  try {
    wikiMapper = require('../lib/wiki-mapper');
  } catch {}

  const isMovie = type === 'movie';
  const mediaCategory = isMovie ? 'movie' : 'series';

  try {
    if (!imdbId && tmdbId && wikiMapper?.getByTmdbId) {
      const mapped = wikiMapper.getByTmdbId(tmdbId, mediaCategory)?.imdbId;
      if (mapped) imdbId = mapped.startsWith('tt') ? mapped : `tt${mapped}`;
    } else if (imdbId && !tmdbId && wikiMapper?.getByImdbId) {
      const mapped = wikiMapper.getByImdbId(imdbId, mediaCategory)?.tmdbId;
      if (mapped) tmdbId = String(mapped);
    }
  } catch {}

  const candidateKeys = new Set<string>();
  if (imdbId) {
    candidateKeys.add(imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`);
  }
  if (tmdbId) {
    candidateKeys.add(tmdbId);
    candidateKeys.add(`tmdb:${tmdbId}`);
  }

  const anilistId = Number(ids?.anilistId);
  const malId = Number(ids?.malId);

  if (isMovie) {
    for (const key of candidateKeys) {
      if (history.movieImdbIds.has(key) || history.movieTmdbIds.has(key)) return 'w';
    }
    if (Number.isFinite(anilistId) && anilistId > 0 && history.anilistIds.has(anilistId)) return 'w';
    if (Number.isFinite(malId) && malId > 0 && history.malIds.has(malId)) return 'w';
    return '';
  }

  // TV Series
  for (const key of candidateKeys) {
    if (history.showImdbIds.has(key) || history.showTmdbIds.has(key)) return 'w';
  }
  if (Number.isFinite(anilistId) && anilistId > 0 && history.anilistIds.has(anilistId)) return 'w';
  if (Number.isFinite(malId) && malId > 0 && history.malIds.has(malId)) return 'w';

  // Series in progress
  let bestProgress: { seen: number; total: number } | undefined;
  const episodesSet = new Set<string>();

  for (const key of candidateKeys) {
    const progress = history.showProgress.get(key);
    if (progress) {
      if (!bestProgress || progress.seen > bestProgress.seen || (progress.seen === bestProgress.seen && progress.total > bestProgress.total)) {
        bestProgress = progress;
      }
    }
    const episodes = history.showEpisodes.get(key);
    if (episodes) {
      for (const ep of episodes) episodesSet.add(ep);
    }
  }

  const seen = Math.max(bestProgress?.seen || 0, episodesSet.size);
  if (bestProgress && bestProgress.total > 0) {
    if (seen >= bestProgress.total) return 'w';
    if (seen > 0) return `s${seen}o${bestProgress.total}`;
  }

  return '';
}

export function patternUsesBtttrHistory(...patterns: Array<string | null | undefined>): boolean {
  return patterns.some(pattern => /\{btttr_history(?:\?[^}]*)?\}/.test(pattern || ''));
}
