# Riff → iPhone: заметки по порту

Рабочий файл для форка `BambusWizard/riff` (upstream: `rootscripts/riff`).
Цель — собрать из десктопного Riff приложение для iPhone (`.ipa`) и ставить его сайдлоадом.

## Что уже сделано / выяснено

1. **Изучили неофициальный iOS-форк** `cloverscripts/riff-muriel`.
   - В его Releases есть тег `ios-latest` («Muriel for iPhone») — неподписанный `.ipa`,
     ставится через Sideloadly / AltStore / SideStore (бесплатный Apple ID — переподпись каждые 7 дней).
   - Сайт со списком форков: https://rootless.shit.vc/fork/
   - В `main`-ветке muriel `.github/workflows/release.yml` собирает **только десктоп**
     (electron-builder: win / linux / mac). Как именно они собирают IPA — **не выяснено**
     (возможно, другая ветка или отдельный workflow).
2. **Форкнули оригинал** → `https://github.com/BambusWizard/riff`, клон в `C:\GitHub\riff`.
   Remotes: `origin` = наш форк, `upstream` = `rootscripts/riff`.
3. **Лицензия MIT** — форкать/менять/распространять можно, `LICENSE` с копирайтом оставить.

## Архитектура оригинала (важно для порта)

Riff — это **Electron**-приложение. На iOS Electron не работает, поэтому переносится только UI.

| Слой | Файлы | Что делает | На iOS |
|---|---|---|---|
| UI | `index.html`, `styles.css`, `app.js` (~650 КБ), `welcome.html`, `themes.js`, `m3shapes.js` | Весь интерфейс | ✅ переиспользуем в WebView |
| Мост Electron | `preload.js` → `window.electronAPI` (~40 методов, в `app.js` ~145 вызовов) | Окна, диалоги выбора файлов, Discord RPC, автообновления, трей, кэш, папки | ❌ нужна заглушка/замена |
| Main-процесс | `main.js`, `launcher.js`, `updater.js`, `discord-rpc.js` | Окно Electron, IPC, апдейты | ❌ не нужен |
| Локальный сервер | `server.js` (~190 КБ, `http.createServer` на `127.0.0.1`, ~41 маршрут `/api/...`) | Библиотека, поиск, загрузки, лирика, метаданные, Spotify | ❌ Node на iPhone нет — главная проблема |
| Внешние бинарники | `tools.js`, `platform.js` (`yt-dlp`, `ffmpeg` через `child_process.spawn`) | Скачивание с YouTube/SoundCloud, конвертация | ❌ запуск процессов на iOS запрещён |

Ключевой факт: `app.js` ходит в бэкенд через
`fetch(\`http://127.0.0.1:${state.serverPort}/api/...\`)` (~36 мест)
и через `window.electronAPI.*`. Значит, порт = **подменить эти две точки входа**.

## Как это сделал muriel (ветка `muriel`, разобрано 2026-10-21)

IPA собирается в ветке **`muriel`** (`main` у них устаревшая). Подход: **Capacitor 8 + `server.js` работает внутри WebView**.
Никакого внешнего сервера нет: Node-модули подменяются шимами, а `server.js` бандлится esbuild'ом в браузерный IIFE.

- `mobile/build.mjs` — esbuild: точка входа `mobile/bridge.js` → `www/mobile-bridge.js`; алиасы
  `fs/http/https/child_process/os/crypto/electron/dns/net/url` → `mobile/shims/*`, `path` → `path-browserify`;
  для `server.js` `./platform` и `./tools` подменяются шимами. Затем копируются `app.js`, `styles.css`, `assets`,
  а в `index.html` патчатся viewport и подключаются `mobile.css`, `mobile-bridge.js`, `mobile-ui.js`.
- `mobile/bridge.js` — перехватывает `window.fetch`: запросы на `http://127.0.0.1:38472/` уходят
  в `http.dispatch()` шима (сокета нет, роутер `server.js` вызывается напрямую, CSRF-токен подставляется).
  Патчит сеттер `src` у `<audio>`/`<img>` и добавляет MutationObserver, чтобы локальные URL превращались в file-URL Capacitor.
  Ставит `window.electronAPI = mobile/electron-api.js`: десктопные методы становятся no-op, пикер файлов —
  системным, «поделиться» идёт через `@capacitor/share`.
- `mobile/shims/fs.js` — индекс в памяти (sync API для `server.js`) с фоновой записью через `@capacitor/filesystem` (`store.js`).
- `mobile/shims/https.js` и `__murielFetch` — нативный HTTP через плагин `CapacitorHttp`, поэтому CORS не мешает.
- `mobile/shims/child_process.js` — **эмулятор yt-dlp**: разбирает аргументы, которые передаёт `server.js`, и
  выполняет их через `mobile/extract.js` (`youtubei.js/web` для YouTube и YT Music, API SoundCloud).
  Аудио с YouTube берётся из HLS-потока клиента visionOS, сегменты склеиваются в `.aac` (`mobile/ts2aac.js`). ffmpeg не нужен.
- `mobile/shims/tools.js` — yt-dlp/ffmpeg всегда «готовы».
- `server.js` правили минимально: флаг `STREAM_VIA_CACHE` (на iOS всё играет из дискового кэша, иначе
  Web Audio не получает cross-origin поток), расширение файла выбирает экстрактор (m4a/mp3 вместо opus).
- Нативная часть: `ios/` закоммичен (SPM, плагины app/filesystem/share), в `Info.plist` есть `UIBackgroundModes: audio`,
  в `AppDelegate.swift` — фикс, из-за которого WebKit глушил звук в фоне (коммит `788bbef`).
- `mobile/mobile.css` (~26 КБ) и `mobile/mobile-ui.js` — мобильная вёрстка и UI-правки.
- `.github/workflows/ios.yml` — `macos-15`, `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, `npm ci` → `node mobile/build.mjs` →
  `npx cap sync ios` → `xcodebuild` без подписи → `Payload/App.app` → `Muriel.ipa` → релиз `ios-latest`
  + `sidestore.json` (источник для SideStore/AltStore).
- Зависимости: `@capacitor/{core,cli,ios,app,filesystem,share}` ^8, `youtubei.js` ^18, `esbuild`, `path-browserify`, `events`, `buffer`.
- Кодовая база muriel сильно разошлась с апстримом (ребрендинг, `app.js` −6.5k строк в diff), поэтому
  переносить нужно **папку `mobile/` + `ios/` + workflow**, а не мержить ветку.

## Варианты порта

**A. Capacitor + удалённый сервер (быстрее всего)**
- UI заворачиваем в Capacitor (iOS WebView).
- `server.js` запускаем на ПК/VPS (он почти самодостаточен), в приложении вместо `127.0.0.1`
  подставляем адрес сервера (+ токен, см. `serverToken` в `preload.js`).
- `window.electronAPI` — заглушка-шим, которая no-op'ит десктопные методы.
- Минус: без сервера приложение не работает.

**B. Capacitor + оффлайн (полноценно, но долго)**
- Переписать нужные маршруты `server.js` на клиентский JS + плагины Capacitor
  (Filesystem, Preferences, фоновое аудио / MediaSession).
- Загрузки с YouTube убрать или вынести на сервер — `yt-dlp` на iPhone не запустить.

**C. Посмотреть, как сделал muriel** и повторить их подход.

## Сборка IPA без Mac

GitHub Actions, раннер `macos-latest` (бесплатно для публичных репо):
`npm ci` → `npx cap sync ios` → `xcodebuild ... CODE_SIGNING_ALLOWED=NO` →
упаковать `Payload/App.app` в `.ipa` → выложить в Releases.
Установка на телефон: Sideloadly (Windows) → доверить разработчику в
«Настройки → Основные → VPN и управление устройством» → включить «Режим разработчика».

## Порт (ветка `ios-port`, 2026-10-22)

Взят подход muriel («server.js в WebView»). Перенесено: `mobile/`, `ios/`, `capacitor.config.json`,
`.github/workflows/ios.yml` (собирает `Riff.ipa` в релиз `ios-latest` при пуше в `main`/`ios-port`), `.github/sidestore-source.js`.
Bundle ID `io.github.bambuswizard.riff`, иконка и сплэш сделаны из `assets/icon.png`.

Отличия от muriel под наш v42.3:
- новый шим `mobile/shims/logger.js` (в muriel нет `logger.js`); в `build.mjs` подмена `./platform|tools|logger` для любых корневых модулей;
- `platform.js`-шим: `resolveBinary('ffmpeg')` → `null`, поэтому скачивание идёт без конвертации и не падает;
- `build.mjs` копирует ещё `m3shapes.js`, `lyrics-rtl.js`, `track-sort.js`, `search-text.js`, `library-tools.js`, `vendor/`;
  панель «Сейчас играет» при старте закрыта;
- `server.js`: `STREAM_VIA_CACHE`, `.aac`, `downloadTrackToDisk` возвращает Promise, prefetch с метаданными;
- `app.js`: на телефоне нет режима `mini`, префетч двух следующих треков (только `isMobile`), `window.RiffCore` и событие `riff:ready` для `mobile-ui.js`,
  `isRightPanelOpen` по умолчанию `false` на телефоне.

Проверка в браузере: `node mobile/build.mjs && node mobile/dev-server.mjs` → http://localhost:5173 (размер iPhone в DevTools).
Пройдено в headless Chrome: старт, поиск YouTube, загрузка в кэш, воспроизведение. На реальном iPhone ещё **не проверено**.

Известное:
- обложка в мини-плеере слегка вылезает за край (`mobile.css` писался под вёрстку muriel);
- на iPhone недоступны ffmpeg-функции (обрезка, выбор битрейта, рендер), темы и плагины из файлов, Discord RPC, автообновление, выбор папок;
- Spotify-авторизация хранится в бинарном `spotify-auth.enc`, а fs-шим держит в памяти только текст (`.json/.lrc/.txt`), так что, скорее всего, не заработает;
- `logger.error` в `server.js` не существует и в оригинале (вызовы обёрнуты в try); в iOS-шиме он есть.

## Куда смотреть дальше (TODO)

- [x] Найти, как muriel собирает IPA — см. раздел выше (ветка `muriel`, вариант «server.js в WebView»).
- [x] Составить полный список методов `window.electronAPI` (`preload.js`) и решить, какие нужны на iOS.
- [x] Составить список маршрутов `/api/*` в `server.js`, отметить, какие зависят от `spawn`/`fs`/`electron`.
- [x] (не нужно: bridge перехватывает fetch) Найти в `app.js` все `serverPort` / `127.0.0.1`, вынести базовый URL в одно место.
- [x] Выбрать вариант: подход muriel (server.js в WebView).
- [x] Добавить Capacitor (`@capacitor/core`, `@capacitor/ios`), `capacitor.config.json`, `webDir`.
- [x] Написать workflow `.github/workflows/ios.yml` для неподписанного `.ipa`.
- [ ] Собрать IPA в Actions, поставить на iPhone и проверить фоновое воспроизведение и экран блокировки (MediaSession, `UIBackgroundModes: audio`).
- [x] Адаптировать вёрстку (из muriel, есть мелкие огрехи) под мобильный экран (`styles.css` рассчитан на десктоп).
- [ ] Не забыть: в `package.json` → `build.files` исключены `*.md`, так что этот файл в сборку не попадёт.

## Предупреждения

- Скачивание с YouTube/SoundCloud нарушает их ToS — для личного использования ок, в App Store не пустят.
- Неподписанный IPA с бесплатным Apple ID живёт 7 дней, максимум 3 сайдлоад-приложения.

## Веб-версия (ветка `web-pwa`, 2026-10-22)

Альтернатива `.ipa` без Apple ID: та же сборка `www/` на GitHub Pages плюс CORS-прокси на Cloudflare Worker.
- `web/worker.js` + `web/wrangler.toml` — прокси `/__proxy?url=…`, пускает только домены, с которыми работает Riff,
  и только с Origin из `ALLOWED_ORIGINS`.
- `RIFF_PROXY_URL` при сборке (`mobile/build.mjs`) задаёт адрес прокси; без него используется `/__proxy` dev-сервера.
- `mobile/pwa/` — манифест и иконки для «На экран Домой».
- `.github/workflows/pages.yml` — сборка при пуше в `web-pwa` → ветка `gh-pages`.
- Риски: фоновое воспроизведение в PWA на iOS нестабильно; Safari может очистить IndexedDB с кэшем.
- Доступ к Worker по ключу: секрет `ACCESS_KEY` (`npx wrangler secret put ACCESS_KEY` в `web/`); страница спрашивает ключ
  один раз и хранит его в `localStorage` (`riff_proxy_key`). В коде и репозитории ключа нет.
- Импорт из Яндекс Музыки (окно импорта Spotify) в веб-версии не работает: Worker выходит не с российского IP.
- Прокси переехал на Cloudflare Pages: `https://riff-proxy.pages.dev` (на iPhone `*.workers.dev` не резолвился).
  Деплой: в `web/` выполнить `cp worker.js pages/_worker.js && npx wrangler pages deploy pages --project-name riff-proxy --branch main`.
  Секреты Pages-проекта: `ACCESS_KEY`, `ALLOWED_ORIGINS` (`npx wrangler pages secret put … --project-name riff-proxy`).
- Синхронизация библиотеки (веб): ключ = аккаунт. Секрет `USERS` = `{"<ключ>": "<имя>"}`, старый `ACCESS_KEY` = пользователь `main`.
  Лайки, плейлисты, история и настройки (`devsize_*`/`riff_*`, кроме привязанных к устройству) лежат в KV `RIFF_DATA`
  под `library:<имя>`. Клиент: `mobile/bridge.js` (выгрузка через 5 с после изменения, загрузка при старте и при возврате в приложение;
  побеждает последнее изменение). Прокси деплоится `npm run deploy-proxy` (конфиг `web/pages-site/wrangler.toml`).
