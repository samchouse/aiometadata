import { useMemo, useState } from "react";
import { useConfig } from "@/contexts/ConfigContext";
import { useSave } from "@/contexts/SaveContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Copy, Loader2, Plus, Save, User, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { TagChip } from "@/components/TagChip";
import { MAX_TAG_NAME_LENGTH, type JellyfinUser, type TagDef } from "@/contexts/config";

/**
 * Typed by hand on a TV remote as often as pasted, so the alphabet leaves out
 * the characters that are read wrong and the groups keep the place visible.
 */
function newClientPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

async function copyToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard!`);
  } catch (err) {
    console.error('Copy failed:', err);
    toast.error('Failed to copy to clipboard');
  }
}

const IMAGE_URL = /^https?:\/\//i;

function Avatar({ src, onClick, title, small }: { src?: string; onClick?: () => void; title?: string; small?: boolean }) {
  const size = small ? 'h-7 w-7' : 'h-10 w-10';
  const face = src && IMAGE_URL.test(src)
    ? <img src={src} alt="" className={cn(size, 'rounded-full object-cover bg-muted')} />
    : (
      <div className={cn(size, 'flex items-center justify-center rounded-full bg-muted text-muted-foreground')}>
        <User className={small ? 'h-4 w-4' : 'h-5 w-5'} />
      </div>
    );
  if (!onClick) return <div className="shrink-0">{face}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="shrink-0 rounded-full ring-offset-background transition hover:ring-2 hover:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {face}
    </button>
  );
}

interface UserRowProps {
  name: string;
  avatar?: string;
  main?: boolean;
  user?: JellyfinUser;
  allTags: TagDef[];
  catalogCount: number;
  trackerOptions: Array<{ value: string; label: string }>;
  watchlistOptions: WatchlistOption[];
  hasPmdb: boolean;
  onChange: (patch: Partial<JellyfinUser>) => void;
  onRemove?: () => void;
}

function UserRow({ name, avatar, main, user, allTags, catalogCount, trackerOptions, watchlistOptions, hasPmdb, onChange, onRemove }: UserRowProps) {
  const chosen = user?.tags ?? [];
  const toggleTag = (tag: string) =>
    onChange({ tags: chosen.includes(tag) ? chosen.filter((t) => t !== tag) : [...chosen, tag] });
  const caps = allTags
    .filter((t) => chosen.includes(t.name) && t.ageRating && t.ageRating !== 'None')
    .map((t) => t.ageRating as string);
  const samePerson = main || user?.trackers === true;
  const [pictureOpen, setPictureOpen] = useState(false);

  const scope = `${catalogCount} catalog${catalogCount === 1 ? '' : 's'}`;
  const capNote = caps.length ? <span className="rounded-full border border-amber-500/40 px-1.5 text-[11px] text-amber-400">{caps.join(', ')} and lower</span> : null;

  const trackerValue = user?.trackerSource ?? (main ? 'auto' : 'inherit');
  const skipValue = user?.skipSource ?? (main ? 'auto' : 'inherit');
  const trackerCaption = trackerValue === 'inherit' ? 'Same as you: follows the choice on your own card.' : resumeSourceCaption(trackerValue, trackerOptions);
  const skipCaption = skipValue === 'inherit' ? 'Same as you: follows the choice on your own card.' : skipSourceCaption(skipValue, hasPmdb);

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-start gap-3">
        <Avatar src={avatar} onClick={() => setPictureOpen((v) => !v)} title={`Picture of ${name}`} />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={name}
              maxLength={MAX_TAG_NAME_LENGTH}
              className="h-8 min-w-[10rem] flex-1 text-sm"
              aria-label={main ? 'Name of the main user' : `Name of ${name}`}
              onChange={(e) => onChange({ name: e.target.value })}
            />
            {main ? (
              <span className="rounded-full border border-primary/40 bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">You</span>
            ) : (
              <label className="flex items-center gap-1.5 text-xs" title="On: this is you on fewer catalogs, sharing your Continue Watching, watched marks and trackers. Off: someone else, with their own.">
                <Switch checked={samePerson} onCheckedChange={(next) => onChange({ trackers: next || undefined })} aria-label={`${name} is the same person as you`} />
                Same person as you
              </label>
            )}
            {onRemove ? (
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground" aria-label={`Remove ${name}`} onClick={onRemove}>
                <X className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
          {pictureOpen || (avatar && !IMAGE_URL.test(avatar)) ? (
            <Input
              value={avatar ?? ''}
              placeholder="Picture address (https://...)"
              className="h-8 font-mono text-xs"
              aria-label={`Picture of ${name}`}
              autoFocus={pictureOpen}
              onChange={(e) => onChange({ avatar: e.target.value || undefined })}
            />
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {main ? 'Your Continue Watching, watched marks and trackers.' : samePerson ? 'You on these catalogs: shares your Continue Watching and watched marks, and writes your trackers; the picks below can still differ from your own card.' : 'Someone else: their own Continue Watching, watched marks and watchlist. Nothing they do reaches your trackers.'} Click the picture to change it.
            </p>
          )}
        </div>
      </div>
      {allTags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-muted-foreground">Tags:</span>
          {allTags.map((t) => (
            <TagChip
              key={t.name}
              name={t.name}
              color={t.color}
              suffix={t.ageRating && t.ageRating !== 'None' ? <span title={`Content rating ${t.ageRating} and lower`}>{t.ageRating}</span> : undefined}
              onClick={() => toggleTag(t.name)}
              pressed={chosen.includes(t.name)}
              dimmed={chosen.length > 0 && !chosen.includes(t.name)}
            />
          ))}
          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{chosen.length === 0 ? 'No tag picked: every catalog' : scope}</span>
            {capNote}
          </span>
        </div>
      ) : null}
      <div className="grid gap-4 border-t pt-3 md:grid-cols-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">{main ? 'Your trackers' : 'Trackers this user reads'}</Label>
          <Select value={trackerValue} onValueChange={(v) => onChange({ trackerSource: v === 'inherit' ? undefined : (v as JellyfinUser['trackerSource']) })}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {!main && <SelectItem value="inherit">Same as you</SelectItem>}
              <SelectItem value="auto">Automatic</SelectItem>
              {trackerOptions.map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
              <SelectItem value="off">This server only</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">{trackerCaption}</p>
          {main && (
            <p className="text-[11px] text-muted-foreground">
              Whatever is picked, what is played through this server is remembered here and always wins over a tracker's view of the same title. Only services that store a playback position are offered, so AniList and MyAnimeList are not.
            </p>
          )}
          {main && trackerOptions.length === 0 && (
            <p className="text-[11px] text-muted-foreground">
              No connected service stores playback positions, so only what is played through this server is shown. That is enough for a single client.
            </p>
          )}
        </div>
        {watchlistOptions.length > 0 && (
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Watchlist</Label>
            <WatchlistPicker value={user?.watchlistServices} options={watchlistOptions} onChange={(next) => onChange({ watchlistServices: next })} inheritLabel={main ? 'Every connected' : 'Same as you'} />
            <p className="text-[11px] text-muted-foreground">
              A client's favourites are the watchlist: the picked shelves merged, and a heart on a title in a client writes to the shelves that take it. MDBList and Trakt file anime under movies and series; Simkl, AniList and MyAnimeList keep an anime shelf.
            </p>
          </div>
        )}
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Skip intro and credits</Label>
          <Select value={skipValue} onValueChange={(v) => onChange({ skipSource: v === 'inherit' ? undefined : (v as JellyfinUser['skipSource']) })}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {!main && <SelectItem value="inherit">Same as you</SelectItem>}
              <SelectItem value="auto">Automatic</SelectItem>
              {hasPmdb ? <SelectItem value="publicmetadb">PublicMetaDB</SelectItem> : null}
              <SelectItem value="introdb">IntroDB</SelectItem>
              <SelectItem value="off">Off</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">{skipCaption}</p>
        </div>
      </div>
    </div>
  );
}

type WatchlistShelf = 'movies' | 'series' | 'anime';
type WatchlistOption = { value: string; label: string; shelves: WatchlistShelf[] };
const SHELF_LABELS: Record<WatchlistShelf, string> = { movies: 'Movies', series: 'Series', anime: 'Anime' };

/** A pick is `service:shelf`; none picked means every shelf of every connected service. */
function WatchlistPicker({ value, options, onChange, inheritLabel }: { value?: string[]; options: WatchlistOption[]; onChange: (next: string[] | undefined) => void; inheritLabel: string }) {
  const picked = (value ?? []).flatMap((token) => {
    const [service, shelf] = token.split(':');
    const option = options.find((o) => o.value === service);
    if (!option) return [];
    return shelf ? [token] : option.shelves.map((s) => `${service}:${s}`);
  });
  const toggle = (token: string) => {
    const next = picked.includes(token) ? picked.filter((t) => t !== token) : [...picked, token];
    onChange(next.length ? next : undefined);
  };
  return (
    <div className="space-y-1">
      <TagChip name={inheritLabel} onClick={() => onChange(undefined)} pressed={picked.length === 0} dimmed={picked.length > 0} />
      {options.map((opt) => (
        <div key={opt.value} className="flex flex-wrap items-center gap-1.5">
          <span className="w-24 shrink-0 text-xs text-muted-foreground">{opt.label}</span>
          {opt.shelves.map((shelf) => {
            const token = `${opt.value}:${shelf}`;
            return <TagChip key={token} name={SHELF_LABELS[shelf]} onClick={() => toggle(token)} pressed={picked.includes(token)} dimmed={!picked.includes(token)} />;
          })}
        </div>
      ))}
    </div>
  );
}

function resumeSourceCaption(value: string, options: Array<{ value: string; label: string }>): string {
  if (value === 'off') {
    return 'This server only: Continue Watching, Next Up and the watched ticks come from what you play through this server, on this configuration. Nothing watched elsewhere appears, and nothing is read from your trackers; plays are still reported to them.';
  }
  if (value === 'auto') {
    const names = options.map((o) => o.label);
    const list = names.length ? names.join(' and ') : 'a connected tracker';
    return `Automatic: Continue Watching merges the paused titles of every connected tracker (${list}), newest first. The watched ticks, Next Up and Upcoming come from one of them, the first connected in the order MDBList, Trakt, Simkl, PublicMetaDB.`;
  }
  const name = options.find((o) => o.value === value)?.label ?? 'that tracker';
  return `${name} only: Continue Watching, the watched ticks, Next Up and Upcoming all come from ${name}, on top of what you play here. Pick this when two trackers disagree and you want one to win.`;
}

function skipSourceCaption(value: string, hasPmdb: boolean): string {
  if (value === 'off') return 'Off: no markers are offered, so clients show no skip button.';
  if (value === 'publicmetadb') return 'PublicMetaDB only: markers come from your PublicMetaDB key and nothing else.';
  if (value === 'introdb') return 'IntroDB only: markers come from IntroDB, which needs no key. Each lookup sends the title, season and episode to it.';
  return hasPmdb
    ? 'Automatic: PublicMetaDB is asked first, and IntroDB fills whatever it lacks. Each lookup sends the title, season and episode to both.'
    : 'Automatic: IntroDB answers, since no PublicMetaDB key is set. Each lookup sends the title, season and episode to it.';
}

function newUserId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface JellyfinDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userUUID: string;
  installUrl?: string | null;
}

function installIdentifier(installUrl: string | null | undefined, fallback: string): string {
  if (!installUrl) return fallback;

  try {
    const path = new URL(installUrl, window.location.origin).pathname;
    const match = path.match(/^\/stremio\/([^/]+)\/manifest\.json$/);
    return match ? decodeURIComponent(match[1]) : fallback;
  } catch {
    return fallback;
  }
}

export function JellyfinDialog({ open, onOpenChange, userUUID, installUrl }: JellyfinDialogProps) {
  const { config, setConfig, auth } = useConfig();
  const { requestSave, isSaving, isDirty, canSave } = useSave();
  const serverAddress = `${window.location.origin}/jellyfin/${installIdentifier(installUrl ?? auth.installUrl, userUUID)}`;
  const mainName = config.jellyfinUserName || config.addonName || userUUID.slice(0, 8);
  const tags = useMemo(() => config.tags ?? [], [config.tags]);
  const users = useMemo(() => config.jellyfinUsers ?? [], [config.jellyfinUsers]);

  const watchlistOptions = useMemo<WatchlistOption[]>(() => {
    const candidates: Array<WatchlistOption & { ready: boolean }> = [
      { value: 'mdblist', label: 'MDBList', shelves: ['movies', 'series'], ready: Boolean(config.apiKeys?.mdblist) && config.mdblistWatchTracking !== false },
      { value: 'trakt', label: 'Trakt', shelves: ['movies', 'series'], ready: Boolean(config.apiKeys?.traktTokenId) && config.traktWatchTracking !== false },
      { value: 'simkl', label: 'Simkl', shelves: ['movies', 'series', 'anime'], ready: Boolean(config.apiKeys?.simklTokenId) && config.simklWatchTracking !== false },
      { value: 'anilist', label: 'AniList', shelves: ['anime'], ready: Boolean(config.apiKeys?.anilistTokenId) && config.anilistWatchTracking !== false },
      { value: 'mal', label: 'MyAnimeList', shelves: ['anime'], ready: Boolean(config.apiKeys?.malTokenId) && config.malWatchTracking !== false },
    ];
    return candidates.filter((c) => c.ready).map(({ value, label, shelves }) => ({ value, label, shelves }));
  }, [config.apiKeys, config.mdblistWatchTracking, config.traktWatchTracking, config.simklWatchTracking, config.anilistWatchTracking, config.malWatchTracking]);

  const catalogCountFor = (chosen: string[]) => {
    const wanted = new Set(chosen.map((t) => t.toLowerCase()));
    return (config.catalogs ?? []).filter((c) => c.enabled && (c.tags ?? []).some((t) => wanted.has(t.toLowerCase()))).length;
  };

  const [newUserName, setNewUserName] = useState('');
  const updateUser = (id: string, patch: Partial<JellyfinUser>) =>
    setConfig(prev => ({
      ...prev,
      jellyfinUsers: (prev.jellyfinUsers ?? []).map(u => (u.id === id ? { ...u, ...patch } : u)),
    }));
  const removeUser = (id: string) =>
    setConfig(prev => ({ ...prev, jellyfinUsers: (prev.jellyfinUsers ?? []).filter(u => u.id !== id) }));
  const addUser = () => {
    const clean = newUserName.trim();
    if (!clean) return;
    if (users.some(u => u.name.toLowerCase() === clean.toLowerCase()) || clean.toLowerCase() === mainName.toLowerCase()) {
      toast.error('There is already a user with that name');
      return;
    }
    const id = newUserId();
    setConfig(prev => ({ ...prev, jellyfinUsers: [...(prev.jellyfinUsers ?? []), { id, name: clean, tags: [] }] }));
    setNewUserName('');
  };

  const [quickConnectCode, setQuickConnectCode] = useState('');
  const [quickConnectProfile, setQuickConnectProfile] = useState('');
  const [approving, setApproving] = useState(false);


  // Only services that store a playback position can answer the Continue
  // Watching row, and only when they are connected and tracking is on.
  const resumeSourceOptions = useMemo(() => {
    const candidates: Array<{ value: string; label: string; ready: boolean }> = [
      { value: 'mdblist', label: 'MDBList', ready: Boolean(config.apiKeys?.mdblist) && config.mdblistWatchTracking !== false },
      { value: 'trakt', label: 'Trakt', ready: Boolean(config.apiKeys?.traktTokenId) && config.traktWatchTracking !== false },
      { value: 'simkl', label: 'Simkl', ready: Boolean(config.apiKeys?.simklTokenId) && config.simklWatchTracking !== false },
      { value: 'publicmetadb', label: 'PublicMetaDB', ready: Boolean(config.apiKeys?.publicmetadb) && config.publicmetadbWatchTracking !== false },
    ];
    return candidates.filter((c) => c.ready);
  }, [
    config.apiKeys?.mdblist,
    config.apiKeys?.traktTokenId,
    config.apiKeys?.simklTokenId,
    config.apiKeys?.publicmetadb,
    config.mdblistWatchTracking,
    config.traktWatchTracking,
    config.simklWatchTracking,
    config.publicmetadbWatchTracking,
  ]);

  const approveQuickConnect = async () => {
    const code = quickConnectCode.replace(/\D/g, '');
    if (code.length !== 6) {
      toast.error('Enter the six digit code the client is showing');
      return;
    }
    setApproving(true);
    try {
      const response = await fetch(`/api/jellyfin/${encodeURIComponent(userUUID)}/quick-connect/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, password: auth.password || undefined, profile: quickConnectProfile || undefined }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || 'Could not approve the device');
      setQuickConnectCode('');
      toast.success(`${result?.app || 'Client'} signed in`, {
        description: result?.device ? `Approved ${result.device} as ${result?.profile || mainName}.` : undefined,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not approve the device');
    } finally {
      setApproving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,80rem)] overflow-y-auto sm:max-w-none">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <img src="/jellyfin_icon.svg" alt="" aria-hidden="true" className="h-5 w-5 object-contain" />
            Jellyfin
          </DialogTitle>
          <DialogDescription>
            Browse this configuration from any Jellyfin client.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="jellyfin-server-address" className="text-sm font-medium">Server address</Label>
            <div className="flex items-center gap-2">
              <Input
                id="jellyfin-server-address"
                value={serverAddress}
                readOnly
                className="font-mono text-sm"
                aria-label="Jellyfin server address"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard(serverAddress, 'Jellyfin server address')}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Add this as a server in your Jellyfin client. Pick a user on its sign-in screen, then use this configuration's password, the client password below, or Quick Connect.
            </p>
            <p className="text-xs text-amber-400">
              Anyone with this address and your password can browse your catalogs. Treat it like the install URL.
            </p>
          </div>

          <div className="grid gap-6 border-t pt-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="jellyfin-quick-connect" className="text-sm font-medium">Quick Connect</Label>
              <div className="flex flex-col gap-2">
                {users.length > 0 ? (
                  <Select value={quickConnectProfile || '__main__'} onValueChange={(v) => setQuickConnectProfile(v === '__main__' ? '' : v)}>
                    <SelectTrigger className="w-full" aria-label="Sign the device in as">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__main__">{mainName}</SelectItem>
                      {users.map((u) => (
                        <SelectItem key={u.id} value={u.id}>{u.name || 'Unnamed user'}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                <div className="flex flex-1 items-center gap-2">
                <Input
                  id="jellyfin-quick-connect"
                  value={quickConnectCode}
                  inputMode="numeric"
                  maxLength={7}
                  placeholder="000000"
                  className="font-mono text-sm tracking-widest"
                  onChange={(e) => setQuickConnectCode(e.target.value.replace(/[^\d ]/g, ''))}
                  onKeyDown={(e) => { if (e.key === 'Enter') approveQuickConnect(); }}
                  aria-label="Quick Connect code"
                />
                <Button size="sm" variant="outline" disabled={approving} onClick={approveQuickConnect}>
                  {approving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                  Approve
                </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Pick Quick Connect on the client's sign-in screen and enter the code it shows here. The client signs in without a password{users.length > 0 ? ', as the user chosen here' : ''}.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="jellyfin-client-password" className="text-sm font-medium">Client password</Label>
              {config.jellyfinAppPassword ? (
                <div className="flex items-center gap-2">
                  <Input
                    id="jellyfin-client-password"
                    value={config.jellyfinAppPassword}
                    readOnly
                    className="font-mono text-sm"
                    aria-label="Jellyfin client password"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyToClipboard(config.jellyfinAppPassword ?? '', 'Client password')}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfig(prev => ({ ...prev, jellyfinAppPassword: newClientPassword() }))}
                  >
                    Replace
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full sm:w-auto"
                  onClick={() => setConfig(prev => ({ ...prev, jellyfinAppPassword: newClientPassword() }))}
                >
                  Generate
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                For clients without Quick Connect. Sign in with this instead of the configuration password, which an account created through a sign-in provider never set. It works only on this address, and replacing it signs the clients out.
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="jellyfin-stream-url" className="text-sm font-medium">Playback</Label>
                <span className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                  config.jellyfinStreamUrl
                    ? 'border-emerald-500/40 text-emerald-400'
                    : 'border-amber-500/40 text-amber-400',
                )}>
                  {config.jellyfinStreamUrl ? 'Stream addon set' : 'Browse only'}
                </span>
              </div>
              <Input
                id="jellyfin-stream-url"
                value={config.jellyfinStreamUrl ?? ''}
                placeholder="https://your-aiostreams/stremio/<config>/manifest.json"
                className="font-mono text-xs"
                onChange={(e) => setConfig(prev => ({ ...prev, jellyfinStreamUrl: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                Paste a stream addon's install URL, such as your AIOStreams. Without one, titles browse but will not play. AIOMetadata never serves the video itself; the client fetches it from that addon directly.
              </p>
            </div>
          </div>
          <div className="space-y-2 border-t pt-4">
            <Label className="text-sm font-medium">Users</Label>
            <p className="text-xs text-muted-foreground">
              Users appear on the client's sign-in screen. A user is made of the tags you pick for it: it sees the catalogs carrying any of them, under their rating limit. Someone else gets their own watch history and Continue Watching; a user that is you shares yours. Tags themselves are made in Catalogs.
            </p>
            <UserRow
              main
              name={mainName}
              avatar={config.jellyfinUserAvatar}
              user={{
                id: '',
                name: mainName,
                tags: config.jellyfinUserTags ?? [],
                trackerSource: config.jellyfinResumeSource ?? 'auto',
                skipSource: config.jellyfinSkipSource ?? 'auto',
                watchlistServices: config.jellyfinWatchlistServices,
              }}
              allTags={tags}
              catalogCount={catalogCountFor(config.jellyfinUserTags ?? [])}
              trackerOptions={resumeSourceOptions}
              watchlistOptions={watchlistOptions}
              hasPmdb={Boolean(config.apiKeys?.publicmetadb)}
              onChange={(patch) => setConfig(prev => ({
                ...prev,
                ...('name' in patch ? { jellyfinUserName: patch.name } : {}),
                ...('avatar' in patch ? { jellyfinUserAvatar: patch.avatar } : {}),
                ...('tags' in patch ? { jellyfinUserTags: patch.tags?.length ? patch.tags : undefined } : {}),
                ...('trackerSource' in patch ? { jellyfinResumeSource: patch.trackerSource as typeof prev.jellyfinResumeSource } : {}),
                ...('skipSource' in patch ? { jellyfinSkipSource: patch.skipSource === 'auto' ? undefined : (patch.skipSource as typeof prev.jellyfinSkipSource) } : {}),
                ...('watchlistServices' in patch ? { jellyfinWatchlistServices: patch.watchlistServices } : {}),
              }))}
            />
            {users.map((user) => (
              <UserRow
                key={user.id}
                name={user.name}
                avatar={user.avatar}
                user={user}
                allTags={tags}
                catalogCount={catalogCountFor(user.tags)}
                trackerOptions={resumeSourceOptions}
                watchlistOptions={watchlistOptions}
                hasPmdb={Boolean(config.apiKeys?.publicmetadb)}
                onChange={(patch) => updateUser(user.id, patch)}
                onRemove={() => removeUser(user.id)}
              />
            ))}
            <div className="flex items-center gap-2">
              <Input
                value={newUserName}
                maxLength={MAX_TAG_NAME_LENGTH}
                placeholder="New user name"
                className="h-8 text-sm"
                aria-label="New user name"
                onChange={(e) => setNewUserName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addUser(); }}
              />
              <Button size="sm" variant="outline" className="shrink-0 whitespace-nowrap" onClick={addUser} disabled={!newUserName.trim()}>
                <Plus className="mr-1 h-4 w-4" /> Add user
              </Button>
            </div>
          </div>
        </div>

        <div className="sticky bottom-0 -mx-4 -mb-4 mt-6 flex flex-col gap-2 border-t bg-card px-4 py-3 sm:-mx-6 sm:-mb-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className={cn('text-xs', isDirty ? 'text-amber-400' : 'text-muted-foreground')}>
            {isDirty
              ? 'Unsaved changes. Clients see users, passwords and settings only once saved.'
              : 'Everything here is saved.'}
          </p>
          <Button size="sm" disabled={!canSave || isSaving || !isDirty} onClick={requestSave} className="w-full sm:w-auto">
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save configuration
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
