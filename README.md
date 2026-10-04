# Playlist Shuffler

A one-purpose static app for playlist `2AtWMamC49m6fXYnE6qCLN`.

## Spotify setup

1. Publish this repository with GitHub Pages from `main`, `/ (root)`.
2. Open https://developer.spotify.com/dashboard and create or reuse your Web API app.
3. Register the exact Pages URL, including the trailing slash, as a redirect URI:
   `https://wachstocknadav-cell.github.io/spotify-shuffler/`
4. Copy the public **Client ID**, never the client secret, into the shuffler's Setup section.
   Alternatively set `CLIENT_ID` in `config.js` so every device is ready without setup.
5. Press **Shuffle Playlist**, authorize with Spotify, then press it again to shuffle.

The developer account needs Spotify Premium. The signed-in account must own or
collaborate on the playlist and be permitted to use the development-mode app.
Scopes: playlist-read-private, playlist-read-collaborative,
playlist-modify-public, playlist-modify-private.

## Android

Open the HTTPS page in Chrome, use its menu, then **Add to Home screen**.
A standalone web manifest and 192/512-pixel icons are included. Internet is required.
If the public Client ID isn't embedded in config.js, enter it once on each browser.

## Behavior and security

- PKCE S256, random state, 10-minute callback expiry, and token refresh; no secret.
- Auth codes are removed from the address bar immediately. Tokens stay in session
  storage for this tab, scoped to the app path; Disconnect clears them.
- No analytics, external scripts, backend, or token logging.
- Reads every page (50 entries at a time), shuffles all positions with unbiased
  Fisher–Yates using Web Crypto, and performs only reorder operations.
- Duplicate, unavailable, and local-file entries are never filtered or recreated.
- Snapshot checks detect concurrent edits; a same-browser lock prevents two tabs
  shuffling together. Avoid editing the playlist elsewhere during a shuffle.
  Snapshot checks cannot provide an atomic lock against another Spotify client.
- Final order and count are verified before success. Large playlists may take
  several minutes because Spotify requires sequential reorder calls.
- Rate limits receive bounded retries using Retry-After. Ambiguous network/server
  failures on writes are not retried: the app stops and reports possible partial
  reordering. No automatic rollback overwrites later edits.
- A uniform random permutation can occasionally match the original order.
- In Spotify, use custom playlist order to see the changes. Playback shuffle is
  a separate Spotify setting.

## Local development

Run `npm test` (Node 18+) and `npm start`, then visit http://127.0.0.1:8765/.
For local OAuth, register that exact loopback redirect in Spotify as well.
Deploy by committing changes to the Pages source branch. No build is required.

## References

- https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
- https://developer.spotify.com/documentation/web-api/reference/reorder-or-replace-playlists-items
- https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
