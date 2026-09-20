// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useQuery } from '@tanstack/react-query';

export type ResolveOnOpenMode = 'user' | 'always' | 'never';
export type UpcomingMode = 'user' | 'caught-up' | 'airing';

export interface JellyfinServer {
  loaded: boolean;
  enabled: boolean;
  liveTv: boolean;
  baseUrl: string;
  resolveOnOpen: ResolveOnOpenMode;
  upcomingMode: UpcomingMode;
}

async function fetchInstanceConfig(): Promise<Record<string, unknown>> {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error(`Instance config ${response.status}`);
  return response.json();
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Whether this instance runs the Jellyfin server, the address clients reach it at, and the modes it forces. */
export function useJellyfinServer(active = true): JellyfinServer {
  const { data, isSuccess } = useQuery({
    queryKey: ['instance-config'],
    queryFn: fetchInstanceConfig,
    staleTime: Infinity,
    refetchOnWindowFocus: (query) => query.state.status === 'error',
    enabled: active,
  });
  const baseUrl = typeof data?.jellyfinBaseUrl === 'string' && data.jellyfinBaseUrl.trim() ? data.jellyfinBaseUrl.trim() : window.location.origin;
  return {
    loaded: isSuccess,
    enabled: Boolean(data?.jellyfinEnabled),
    liveTv: Boolean(data?.jellyfinLiveTv),
    baseUrl,
    resolveOnOpen: pick(data?.jellyfinResolveOnOpen, ['user', 'always', 'never'] as const, 'user'),
    upcomingMode: pick(data?.jellyfinUpcomingMode, ['user', 'caught-up', 'airing'] as const, 'user'),
  };
}

export function installIdentifier(installUrl: string | null | undefined, fallback: string): string {
  if (!installUrl) return fallback;

  try {
    const path = new URL(installUrl, window.location.origin).pathname;
    const match = path.match(/^\/stremio\/([^/]+)\/manifest\.json$/);
    return match ? decodeURIComponent(match[1]) : fallback;
  } catch {
    return fallback;
  }
}

export function jellyfinServerAddress(baseUrl: string, userUUID: string, installUrl?: string | null): string {
  const serverId = installIdentifier(installUrl, userUUID);
  return `${baseUrl.replace(/\/+$/, '')}/jellyfin/${serverId}`;
}
