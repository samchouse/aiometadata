// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useEffect, useState } from 'react';

const IMAGE_URL = /^https?:\/\//i;
let imagePrefixRequest: Promise<string> | null = null;

function getCollectionImagePrefix(): Promise<string> {
  if (!imagePrefixRequest) {
    imagePrefixRequest = fetch('/api/collections/image-prefix')
      .then(response => (response.ok ? response.json() : null))
      .then(data => typeof data?.prefix === 'string' ? data.prefix.replace(/\/+$/, '') : '')
      .catch(() => '');
  }
  return imagePrefixRequest;
}

/** Route editor previews through the server so private and CORS-blocked art can load. */
export function useCollectionImagePreview(url: string): string {
  const [previewUrl, setPreviewUrl] = useState('');

  useEffect(() => {
    let cancelled = false;
    const source = url.trim();
    setPreviewUrl('');
    if (!IMAGE_URL.test(source)) return () => { cancelled = true; };

    void getCollectionImagePrefix().then(prefix => {
      if (cancelled) return;
      setPreviewUrl(prefix && !source.startsWith(`${prefix}/`) ? `${prefix}/${source}` : source);
    });

    return () => { cancelled = true; };
  }, [url]);

  return previewUrl;
}
