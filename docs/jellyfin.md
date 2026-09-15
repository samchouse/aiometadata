# Jellyfin server

AIOMetadata can present a configuration as a Jellyfin server. A Jellyfin client signs in to it the way it would to a real server and gets libraries made of your catalogs and collections, title pages with the metadata you already configured, a version picker fed by your stream addon, Continue Watching, Next Up, Upcoming, watched ticks, a watchlist and skip-intro markers. Nothing is transcoded or stored: AIOMetadata answers the browsing side of the Jellyfin API and the client fetches the video straight from the stream addon.

It is optional. With it switched off the addon behaves exactly as before.

## Before you start

- **Switch it on.** `JELLYFIN_API_ENABLED=true` in the environment, or **Jellyfin API** under **Server** in the dashboard. The dialog described below appears in the configuration page only once it is on.
- **A stream addon.** Without one, titles browse but do not play. Any addon that answers stream requests works; AIOStreams is the one most people use and the one that adds the most (media info, subtitles, release details).
- **HTTPS on a stable hostname.** Clients keep the address they signed in with, and playback URLs are handed to them as given by the stream addon.
- **Redis is recommended.** Sign-in tokens and Quick Connect codes live there. Without it they are kept in memory, so every restart signs every client out.
- **A database.** Positions and watches played through the server are written to the `jellyfin_playstate` table in the same database the rest of the addon uses.

## Connecting a client

Open your configuration, save it, and press **Jellyfin** next to **Install**. The dialog shows everything a client needs.

| | |
|---|---|
| Server address | `https://<your-host>/jellyfin/<configuration id>` |
| User | one of the users listed on the client's sign-in screen; the first is you |
| Password | the configuration password, or the client password below |
| Quick Connect | a code shown by the client, entered in the dialog |

Treat the address like the install URL: anyone holding it and a password can browse your catalogs.

**Configuration password.** Works everywhere the configuration password works. An account created through a sign-in provider never set one, which is what the client password is for.

**Client password.** A separate password that only opens this address. Replacing it signs every client out, which is the quickest way to revoke a device you no longer trust.

**Quick Connect.** The client shows a code, you enter it in the dialog, and the client is signed in without any password, as the user picked in the dialog. Codes expire after ten minutes. Clients that lack Quick Connect use the client password.

Sign-ins last thirty days (`JELLYFIN_TOKEN_TTL`, seconds); after that the client asks for the password again.

## Users

The server shows a list of users on the sign-in screen, the way a household's Jellyfin does. The first user is you. Any further user is a card in the dialog, and a user is made of:

- **Tags.** The catalogs, collections and search catalogs the user sees are the ones carrying any of the user's tags. Tags themselves are made in **Catalogs**; a tag with a content rating caps what the user can open. A user with no tags sees everything.
- **Same person as you.** On, the user is you on another set of catalogs: shares your Continue Watching and watched marks, and what they play is written to your trackers. Off, the user is someone else, with their own Continue Watching, watched marks and watchlist kept apart from yours; nothing they play or favourite reaches your trackers. What they read from your trackers is their card's **Trackers** pick, so a user who should see your history without writing to it is one with the switch off and the pick left on Automatic.
- **Trackers**, **Watchlist** and **Skip intro and credits**, explained in the sections below. Each card carries its own copies, so a user who is you can still read a different watchlist shelf or a different skip source.
- **Picture.** Click the avatar to set an image URL.

A user is stored in the configuration and reaches the client once the configuration is saved.

### What users are for

Users are not only for other people. Because each one carries its own tags and its own pickers, they double as profiles of a single account, and the sign-in screen becomes a way to switch between them on any client.

**Two views of one account.** Tag your film and series catalogs `tv` and your anime catalogs `anime`, then make two users: one holding `tv`, one holding `anime`. Signing in as the first gives a client with nothing but films and shows, and a **Watchlist** pick of MDBList so its favourites are that shelf. Signing in as the second gives an anime-only client, its **Watchlist** pointed at Simkl's anime shelf and AniList, and, with **Trackers** set to Simkl, Next Up and the watched ticks read from it rather than from whichever tracker comes first under Automatic. Both are you: with **Same person as you** on, plays from either land on your trackers and both share one Continue Watching. Set the anime user's switch off instead and it keeps reading your trackers but writes nothing, which is the way to browse and watch under a second identity without the trackers ever hearing about it.

**A household.** A partner gets a user with the switch off: their own Continue Watching, watched marks and watchlist, kept apart from yours, and none of their plays reaching your trackers. A child gets a user holding a tag with a content rating on it, so the catalogs they see are the ones carrying that tag and nothing above the rating opens, plus **Skip intro and credits** and a watchlist of their own if wanted.

**A trial of one tracker.** A user that is you, with **Trackers** set to one service, shows what that service alone would put on the shelves, without changing what your own card reads.

Users cost nothing on the server: they are a scoping of the same configuration, and a client remembers which one it signed in as.

## Libraries

Every browsable catalog in the configuration becomes a library. Movie and series catalogs are typed as such, so clients file them under Movies and Shows; anime and other types are left untyped and appear as plain folders.

### Collections

The collection builder's entries are served in the order they hold on the home screen, ahead of the plain catalogs:

- A **classic row** is a catalog placed early: its catalog becomes one of the first libraries, and does not appear a second time further down.
- A **collection** becomes a library of its own, typed as a box set library so clients draw it as one, with the collection's backdrop as its artwork. Each **folder** in it is one box set, carrying the folder's cover, backdrop and logo, drawn in the folder's shape (poster, landscape or square). Opening a box set lists the folder's **sources** walked in order, one after the other, with a source's genre applied where one is set and duplicates dropped, paged the way any library is. A folder whose sources are all outside the user's catalogs is not shown, and a collection with no folder left is not shown either.

Both can be restricted to users through the **Users** field in the editor. An entry with no users is for everyone. A collection or row cannot be created or edited from a client; the server declines the request and points at the configuration.

### Search

Search catalogs are tagged too, from the tag chip on each row under **Search**. Once any search catalog carries a tag, a user searches only the search catalogs holding one of their tags, so a child's user can search the kids catalog and nothing else, and an anime user is not offered a film search. While no search catalog is tagged, every user searches everywhere. A user with no tags always searches everywhere.

## Playback

### The version picker

A title's versions are the stream addon's streams, returned as the item's media sources, so the client builds the same version picker it would for a server holding several files. By default a title opens at once with a placeholder version and the addon is asked when the picker is opened or play is pressed. A client that names `MediaSources` in the fields it asks for, as Infuse does, builds its picker from the item and plays nothing without them, so it is always answered in full. Other clients that show versions or quality badges on the title page can use `JELLYFIN_ITEM_SOURCES_WAIT_MS` to make the item request wait that long for the addon, and past it the title opens with the placeholder as before. The server also starts a background lookup when opening a title to prime the short-lived stream and subtitle caches. The most versions offered is `JELLYFIN_MAX_MEDIA_SOURCES` (50).

Each version carries what can be read from the stream: resolution and dynamic range, video codec, audio codec, channels and a profile such as Dolby TrueHD with Atmos or DTS:X, languages, file size, bitrate and runtime. Where the stream addon sends parsed release data the picture is complete; where it does not, the release name is parsed on the server. Clients render this as the badges on their title pages.

The stream addon adds parsed data only for a user agent it recognises. `JELLYFIN_STREAM_USER_AGENT` sets what the server sends; for AIOStreams a value starting with `AIOStreams/` is what unlocks it.

### Subtitles

External subtitles come from two places, both offered as subtitle streams on each version:

- the subtitle links a stream itself carries;
- every addon in the configuration that declares a subtitle resource, asked with the file's hash, size and name so it can match the release.

Anime titles known under a Kitsu or MyAnimeList id are also asked under their IMDb id, since most subtitle addons only know that one. Results are spread across languages round-robin so one language with dozens of files does not crowd out the rest: `JELLYFIN_SUBTITLES_PER_LANGUAGE` per language, `JELLYFIN_SUBTITLES_MAX` in total. SRT, WebVTT, ASS and JSON are converted to whatever the client asks for. Converted text is kept in memory (`JELLYFIN_SUBTITLE_BODY_CACHE_MB`) so a seek or a second device does not fetch the file again.

### Trailers

Trailers come from the metadata provider, or from a trailer addon named in the configuration (`TRAILER_ADDON_*` settings). Up to `JELLYFIN_MAX_TRAILERS` are offered per title.

### Skip intro and credits

Intro, recap and outro markers are served as media segments, so a client with a skip button shows one. The **Skip intro and credits** picker chooses where they come from:

| Choice | Source |
|---|---|
| Automatic | PublicMetaDB when a key is set, IntroDB for what it lacks |
| PublicMetaDB only | your PublicMetaDB key and nothing else |
| IntroDB only | IntroDB, which needs no key |
| Off | no markers, no button |

Each lookup sends the title, season and episode to the service asked. Other users inherit your choice unless their card says otherwise.

## Watch history

### What the server records

Clients report playback the way they would to Jellyfin: a start, progress every few seconds, pauses, and a stop. The server writes the position to the playstate table and reports the play to every tracker with watch tracking on, through the same path the addon uses for its own playback reporting. A title is marked played once a stop lands at or past `JELLYFIN_PLAYED_THRESHOLD` percent of its runtime (80, the same point the trackers mark a watch); the runtime is the player's own length when the client reports one in the play state's `Item.RunTimeTicks`, else the file's length as the stream addon reported it, else the metadata's. A stop before that keeps the position for Continue Watching.

A tracker records a play only when all three hold:

1. the service is connected under **Integrations**;
2. its switch under **Watch Tracking** in **General** is on, and the media type is one the service's options include;
3. the play went through a server that reports playback: this addon's Jellyfin server, or AIOStreams' with the handoff described further down.

A title played in any other client, or on a Jellyfin server that was not signed in to through this addon, records nothing here, whatever the trackers show for it.

- Between pause and stop, a playing position is written every `JELLYFIN_PROGRESS_WRITE_INTERVAL` seconds, so a client that closes without stopping loses at most that much. Only the table is written in between; trackers hear the start, pauses and the stop.
- A mark-played or mark-unplayed that repeats a decision within `PLAYBACK_MARK_REPEAT_WINDOW` seconds is an echo of it and is not sent again.
- A film is recorded under both its IMDb and TMDB ids, and an episode under every id its show is known by, so a client that opens the same title from an anime catalog and a series catalog sees one history.

### The tracker picker

Reading and writing are two different things here. Every play through the server is **written** to every tracker with watch tracking on, whatever is picked below, as long as the user is you. **Trackers** on a user card decides what is **read back** from them and shown in the client, on top of what was played through this server:

| Choice | Continue Watching | Watched ticks, Next Up, Upcoming |
|---|---|---|
| Automatic | paused titles of every connected tracker, merged, newest first | the first connected in the order MDBList, Simkl, PublicMetaDB |
| One tracker | that tracker alone | that tracker alone |
| This server only | what was played here | what was played here |

**Automatic** is the default. Continue Watching is the union of every tracker's paused titles, so a film paused on one and a show paused on another both appear. The watched ticks, Next Up and Upcoming come from one tracker only, the first connected in the order above, because a title cannot read as unwatched in a library while sitting part-played in Continue Watching just because two trackers were asked and disagreed.

**One tracker** makes that tracker the only thing read: Continue Watching, ticks, Next Up and Upcoming all follow it. Pick this when two trackers disagree and you want one to win, or when one holds a history you do not want on the shelves.

**This server only** reads nothing from any tracker. Continue Watching, Next Up and the ticks show what was played through this server, on this configuration, and nothing watched elsewhere appears. Plays are still reported to the trackers. It is also what the playstate sync below keys on: a configuration set to this is skipped by it, so nothing is pulled from the trackers in the background either. Titles the sync already pulled before the switch stay in the table, which is why a tick can survive the change.

A user that is not you never writes to your trackers, whatever their card says. Their card's own **Trackers** pick still decides what they read: left on Automatic they see your trackers' paused titles and history on top of their own plays, which is how a user set up as someone else can follow your history without touching it; set to **This server only** they see their own plays alone.

Not every tracker holds every kind of state:

| | Paused positions | Watch history | Next Up | Upcoming | Watchlist |
|---|---|---|---|---|---|
| MDBList | yes | yes | yes, its own Up Next | yes | movies, series |
| Simkl | yes | yes | shows in **Watching** | | movies, series, anime |
| PublicMetaDB | yes | yes | derived from history | | |
| AniList, MyAnimeList | | | | | anime |

### The shelves

**Continue Watching** merges the positions held in the playstate table with the paused titles of the trackers chosen above. A position played here wins over the tracker's copy of the same title. Trackers expire paused sessions on their own schedule (MDBList after thirty days), and a session a client started but never paused or stopped is completed by MDBList on its side, so a title that vanished from the shelf without being finished here was most likely closed by the tracker.

**Next Up** lists the next unwatched episode of shows in progress. From MDBList it is MDBList's own Up Next list, read `JELLYFIN_NEXTUP_MDBLIST_PAGES` pages deep; from Simkl it is the next episode of every show in the Watching list, so a planned, on-hold or dropped show never shows up at its first episode; from PublicMetaDB and from plays through this server it is derived from the last finished episode, looking back `JELLYFIN_NEXTUP_OWN_DAYS` days. Specials and unaired episodes are never offered. A candidate that turns out to be finished, unaired or unknown to the metadata is skipped and the page is filled from the ones after it; the reason is in the debug log.

**Upcoming** lists episodes airing within `JELLYFIN_UPCOMING_DAYS` days for every show MDBList lists as followed, plus up to `JELLYFIN_UPCOMING_LOCAL_SHOWS` shows known only from plays here, plus watchlist films not yet released. The followed list is kept `JELLYFIN_UPCOMING_TTL` seconds.

**Watched ticks** on a film or episode mean the tracker's history, or the playstate table, lists it. A series shows its progress as watched out of aired, counting only regular episodes that have already aired, so a show with specials or a season still airing can reach a full tick. Ticks are applied on library pages, Latest rows and search results alike.

### How tracker state is read

The watch history of the chosen tracker is read once into a snapshot and kept `JELLYFIN_WATCHED_TTL` seconds; the snapshot is rebuilt only when the tracker's activity digest changes, so a large history is not re-read on every page. MDBList history is read `JELLYFIN_WATCHED_MAX_PAGES` pages of a thousand deep. Paused positions are cheaper and kept `JELLYFIN_RESUME_TTL` seconds; a play through this server invalidates both immediately.

Every read and write to MDBList goes through the addon's rate limiter and counts against the key's daily quota; Simkl's per-token limits are respected the same way. A `429` in the log is the limiter being hit upstream and the request retried, not lost.

### The playstate sync

Every `JELLYFIN_PLAYSTATE_SYNC_INTERVAL` seconds (thirty minutes) the server pulls tracker state into the playstate table for every configuration with a tracker chosen, starting `JELLYFIN_PLAYSTATE_SYNC_DELAY` seconds after boot. The table wins on anything it already holds:

- a paused title the table has never seen takes the tracker's position and date;
- a title the table holds at a position is only marked finished when the tracker dates the watch after that position, since an older watch is the earlier viewing this one is a rewatch of;
- a title the table already marks played is left alone.

The sync is logged under the configuration it runs for, so the log filter by configuration id shows it.

## Watchlist

The watchlist is the client's favourites. Marking a title favourite adds it to the trackers, removing the favourite takes it off them, and the Favourites view of the client (filtered by type, newest first) is the merged watchlist of the trackers chosen. A client that lets you rename views can call it Watchlist.

**Watchlist** on a user card picks which shelves are read and written: each connected tracker offers its shelves (MDBList movies and series, Simkl movies, series and anime, AniList and MyAnimeList anime), and picking none means every connected one. A write goes to every picked shelf that takes the title's kind, so an anime lands on Simkl's anime shelf and AniList, not on the movies shelf. Entries are matched to titles by IMDb, TMDB, TVDB, Kitsu and MyAnimeList ids, so the same title on two catalogs shows one heart. The merged list is kept `JELLYFIN_WATCHLIST_TTL` seconds; a change through the client refreshes it at once.

## AIOMetadata inside AIOStreams' Jellyfin server

AIOStreams has a Jellyfin server of its own. In that setup the client signs in to AIOStreams, not to this addon, and AIOMetadata is one of the addons installed in it, supplying the catalogs and title pages. Nothing in this guide's sign-in, users or shelves sections applies then; AIOStreams builds those. What AIOMetadata still does is the tracking, through two resources it declares in its manifest once **Playback reporting** under **General** is set to **When playback starts and stops**:

- **playback.** AIOStreams sends the plays its clients report as start, stop, mark-played and mark-unplayed events, with the title known under every id it holds, so a show keyed on MyAnimeList with episodes keyed on Kitsu is still recorded once. A stop past the trackers' 80 percent counts as a watch; an earlier one is a resume point. Each event is reported to every tracker with watch tracking on, the same way a play through this addon's own server is. A repeated event within `PLAYBACK_MARK_REPEAT_WINDOW` is an echo and dropped.
- **watch_state.** AIOStreams reads back what the trackers and this addon hold, so its Continue Watching reflects other devices. The answer is the same merged view this addon's own resume shelf uses, following the **Trackers** pick, newest first, `WATCH_STATE_PULL_ITEMS` titles at a time, and may be reused for `WATCH_STATE_PULL_TTL` seconds before AIOStreams asks again.

AIOStreams sends and reads these only with its `WATCH_STATE_HANDOFF_ENABLED` switched on. With **Playback reporting** left on **When a title is opened**, neither resource is declared and AIOStreams records nothing through this addon; opening a title is then the only signal, as for any other client.

Running both servers at once is fine: a client on this addon's server plays through AIOStreams as a plain stream addon, which is not a session AIOStreams reports, so a play is recorded once, by whichever server the client signed in to.

## Artwork and appearance

Posters, backdrops and logos are the ones the configuration already serves. With the [image cache](image-cache.md) on, **Bring Posters to 2:3** (`POSTER_CACHE_SHAPE_POSTERS`, on by default) brings a poster that is not roughly 2:3 to shape before it is stored: a slightly off one is cropped, a landscape one is placed over a blurred fill. This matters in clients that lay posters on a fixed grid, where one wide image otherwise overlaps its neighbours. Without the cache the same shaping is done as the poster is served.

`JELLYFIN_CUSTOM_CSS` is handed to web clients as the server's custom CSS. A theme is one line, an `@import` of its stylesheet.

## Settings

All of these are in the dashboard under **Server**, or as environment variables, unless marked environment-only.

### Server

| Setting | Default | What it does |
|---|---|---|
| `JELLYFIN_API_ENABLED` | `false` | Serve the Jellyfin API at `/jellyfin/<configuration>`. |
| `JELLYFIN_CUSTOM_CSS` | | CSS served to web clients. |
| `JELLYFIN_TOKEN_TTL` (env) | `2592000` | How long a sign-in lasts, in seconds. |
| `JELLYFIN_QUICK_CONNECT_TTL` (env) | `600` | How long a Quick Connect code is valid. |
| `JELLYFIN_CATALOG_MIN_PAGE` | `10` | A catalog page shorter than this is the last one, so short lists are not asked for pages they do not have. |
| `JELLYFIN_SHELF_META_CONCURRENCY` | `4` | Titles the Continue Watching and Next Up shelves fetch metadata for at once. A cold anime title costs several requests, and MyAnimeList blocks a burst. |

### Playback

| Setting | Default | What it does |
|---|---|---|
| `JELLYFIN_STREAM_USER_AGENT` | | User agent sent to the stream addon. AIOStreams attaches parsed release data only for one it recognises. |
| `JELLYFIN_ITEM_SOURCES_WAIT_MS` | `0` | How long opening a title waits for the stream addon so the versions are on the page itself. 0 opens at once and resolves them from the version picker or play. |
| `JELLYFIN_STREAM_TIMEOUT_MS` (env) | `15000` | How long a stream request may take. |
| `JELLYFIN_STREAM_CACHE_TTL` (env) | `60` | How long a title's stream list is reused, in seconds. |
| `JELLYFIN_MAX_MEDIA_SOURCES` (env) | `50` | The most versions offered for a title. |
| `JELLYFIN_MAX_TRAILERS` (env) | `8` | The most trailers offered for a title. |
| `TRAILER_ADDON_TIMEOUT_MS`, `TRAILER_ADDON_TTL`, `TRAILER_ADDON_EMPTY_TTL` | | How long a trailer addon may take, how long its answer is kept, how long a miss is left alone. |

### Subtitles

| Setting | Default | What it does |
|---|---|---|
| `JELLYFIN_SUBTITLES_PER_LANGUAGE` | `3` | Subtitle files offered per language. |
| `JELLYFIN_SUBTITLES_MAX` | `40` | Subtitle files offered across all languages. |
| `JELLYFIN_SUBTITLE_TTL` | `3600` | How long the subtitles found for a file, and their converted text, are kept. |
| `JELLYFIN_SUBTITLE_FETCH_TIMEOUT_MS` | `15000` | How long a subtitle file, or an addon's search, may take. |
| `JELLYFIN_SUBTITLE_BODY_CACHE_MB` | `64` | Memory held for converted subtitle text. |

### Watch history

| Setting | Default | What it does |
|---|---|---|
| `JELLYFIN_PLAYED_THRESHOLD` | `80` | Share of the runtime a stop must reach to mark a title played. The trackers mark a watch at 80, so a higher value leaves a title finished on them yet still resumable here. |
| `JELLYFIN_PROGRESS_WRITE_INTERVAL` | `60` | Seconds between position writes while playing. `0` writes on pause and stop only. |
| `PLAYBACK_MARK_REPEAT_WINDOW` | `300` | A repeated mark within this window is not sent to the trackers again. |
| `JELLYFIN_PLAYSTATE_SYNC_INTERVAL` | `1800` | Seconds between pulls of tracker state into the playstate table. |
| `JELLYFIN_PLAYSTATE_SYNC_DELAY` (env) | `120` | Seconds after boot before the first pull. |
| `JELLYFIN_RESUME_TTL` (env) | `60` | How long paused positions read from a tracker are kept. |
| `JELLYFIN_RESUME_TIMEOUT_MS` (env) | `10000` | How long a tracker read may take. |
| `JELLYFIN_WATCHED_TTL` (env) | `3600` | How long the watched snapshot is kept. |
| `JELLYFIN_WATCHED_MAX_PAGES` | `50` | Pages of a thousand read from MDBList history when the snapshot is rebuilt. |
| `JELLYFIN_NEXTUP_MDBLIST_PAGES` | `5` | Pages of a hundred read from MDBList's Up Next. |
| `JELLYFIN_NEXTUP_OWN_DAYS` | `120` | How far back Next Up looks for episodes finished through this server. |
| `JELLYFIN_UPCOMING_DAYS` | `90` | How far ahead Upcoming looks. |
| `JELLYFIN_UPCOMING_TTL` | `21600` | How long the list of followed shows is kept. |
| `JELLYFIN_UPCOMING_LOCAL_SHOWS` | `60` | Shows known only from local plays checked for an upcoming episode. |
| `JELLYFIN_UPCOMING_WATCHLIST_LIMIT` (env) | `100` | Watchlist films checked for a release date. |
| `JELLYFIN_WATCHLIST_TTL` (env) | `300` | How long the merged watchlist is kept. |
| `WATCH_STATE_PULL_TTL` | `300` | How long a front end reading watch state from the addon may reuse an answer. |
| `WATCH_STATE_PULL_ITEMS` | `100` | In-progress titles a watch state read returns. |

## Client notes

Clients differ in what they ask for, and a few things are worth knowing when a row looks short or a button is missing.

- **Latest rows** are asked without paging. A client that asks for twenty on the home screen and fifty when the library is opened shows at most that many, whatever the catalog holds; open the library itself to browse it all.
- **Next Up** with resumable episodes excluded, as some clients ask, shows only episodes not yet started; a half-watched one is in Continue Watching instead.
- **Upcoming** has no window parameter in the Jellyfin API; `JELLYFIN_UPCOMING_DAYS` sets it server-side.
- **Favourites** is the watchlist. Not every client offers a remove-from-favourites action on every screen; the title page's heart is the reliable place.
- **Playlists** are not served. A client that offers to play a favourite rather than open it is treating the row as a playlist; use the Favourites view.
- **Web clients** cache the server's views; a library that was just tagged away or added appears after a reload.

## Troubleshooting

**The Jellyfin button is missing from the configuration page.** `JELLYFIN_API_ENABLED` is off, or the page was loaded before it was switched on.

**A client says the server is unavailable right after signing in.** Usually a tracker read that failed while building the first shelves. The log, filtered by the configuration id, names the tracker and the status: `401` is a wrong or revoked key or token, `429` is the tracker's rate limit, and both are retried on the next request.

**A play was not recorded on one tracker.** Check the three conditions under [What the server records](#what-the-server-records): the service must be connected, its switch under **Watch Tracking** in **General** must be on for that media type, and the play must have gone through this server or AIOStreams' handoff. A tracker that was connected after the play, or whose switch is off, has no way to hear about it; the log filtered by the configuration id shows each event as it arrives and any tracker that refused it. A user that is not you never writes to trackers at all.

**A finished episode stays in Continue Watching with a few minutes left.** The client's last position fell short of the threshold against the runtime the server knows. That runtime comes from the metadata unless the client or the stream addon reported the file's own length, and a file that cuts the credits ends a few percent early by the metadata's count. Setting the stream addon's user agent so it reports durations fixes the count; `JELLYFIN_PLAYED_THRESHOLD` moves the line.

**Continue Watching lost titles.** Trackers expire paused sessions, and MDBList completes a session that was started but never stopped; a title played here keeps its position in the playstate table regardless. Check the tracker's own site first: if the title is gone there, it is gone from the shelf.

**A show sits at episode one in Next Up although it was never started.** On Simkl, only shows in Watching are offered; move the show out of Plan to Watch on Simkl or start it. On MDBList, Next Up is MDBList's own list.

**Watched ticks are missing after switching trackers.** The snapshot is kept `JELLYFIN_WATCHED_TTL` seconds; a play through the server refreshes it immediately, or wait it out.

**"No watched history"** in the log at debug level is not an error; the tracker has nothing yet.

**Posters overlap in a grid.** One of them is landscape. Make sure **Bring Posters to 2:3** is on in the image cache settings, or switch the poster source for that title's provider.

**A title opens but the version list is empty.** The stream addon returned nothing when the picker asked; opening the picker again retries. The background lookup may still be in progress when the page first opens. The log shows the addon's answer.

**Subtitles from a subtitle addon do not appear.** The addon must declare a subtitle resource in its manifest and be part of this configuration. Anime titles are also asked under their IMDb id; a title with no IMDb mapping gets only the subtitles its stream carries.
