# Riff song library

A service on your PC that keeps a copy of every song the phones played to the end or liked, under its real
name. It is one more source for the app: a song in the library plays from the phone's cache, then from the
PC, and only then from YouTube and the other services. Run it whenever you like; the phones send what piled
up while it was off.

## Start and stop

- Desktop shortcuts (made by `powershell -ExecutionPolicy Bypass -File library\windows\install-shortcuts.ps1`):
  **Riff Library** starts it (a minimized window), **Riff Library stop** stops it,
  **Riff Library page** opens the library page.
- Or `npm run library` (`node library/service.js --dir <folder>` for another folder), `node library/service.js --stop`.

On the first start it asks for your access key (the one entered in the app), so the phones can find the PC
through the Riff worker. It installs yt-dlp, ffmpeg and cloudflared next to the desktop app's tools.

## The library folder

Default: `Music\Riff Library` in your home folder.

| | |
|---|---|
| `config.json` | settings (below) and the two phones' library keys |
| `library.json` | the catalog: every song, its names, sources and status |
| `songs/` | the audio, as the service sent it (m4a mostly), tagged with our names and cover |
| `covers/` | the covers written into the files |
| `backups/` | a copy of the catalog for each of the last 14 days |

`config.json`: `maxGB` (20), `port` (38510), `proxy` (for yt-dlp, e.g. `socks5://127.0.0.1:1080`),
`tunnel` (true), `worker`, `workerKey`, `backupDir` (a folder on another disk or in OneDrive: songs, covers and
catalog are mirrored there every 15 minutes; nothing is ever deleted from it).

## Names

Each new song is looked up in iTunes, Deezer, MusicBrainz (and Yandex Music when the PC can reach it). A sure
match renames it ("Lida - Song" by "minecrafter" becomes "Song" by "Lida", with album, year and cover); an
unsure one keeps the cleaned-up upload name and waits on the library page under **To check**, with the
catalogues' guesses to pick from. Names you type or confirm are never changed again. The phones show these
names in search, artist pages, likes, history and playlists.

## How the phones reach it

The service opens a Cloudflare quick tunnel and tells the worker its address (`/__library`); a phone asks the
worker with its access key and gets the address and its own library key. Settings -> Storage -> Song library
on the phone shows whether the PC is reachable and how many songs wait to be sent.
