// iOS layout behaviour on top of app.js: mini player <-> now-playing sheet, swipe to dismiss,
// and the progress line on the mini player.

// Background playback: iOS suspends Web Audio when the app is backgrounded or the screen locks,
// but keeps a plain <audio> element playing (and on the lock screen). So on iPhone the engine never
// routes the element through an AudioContext. Speed/pitch still work (they're element properties);
// EQ, reverb, distortion and the visualizer need the graph and are off. app.js builds the engine on
// DOMContentLoaded, which hasn't fired yet when this script runs.
(() => {
  // desktop's default text scale (1.25x) is sized for a monitor; phones start at 1.0x unless the user picked one
  if (!localStorage.getItem('riff_font_scale')) localStorage.setItem('riff_font_scale', '80');
  const Engine = window.RiffAudioEngine;
  if (!Engine) return;
  Engine.prototype.init = function (audioElement) { this.__element = audioElement || this.__element; };
  // iOS ignores element.volume (hardware buttons own it); mute still works
  Engine.prototype._applyMasterVolume = function () {
    if (this.__element) this.__element.muted = !!this.isMuted || this.volume === 0;
  };
})();

// track rows: source + downloaded icons, can be switched off in Settings -> Storage
const ROW_BADGES = 'riff_row_badges';
const rowBadgesOn = () => { try { return localStorage.getItem(ROW_BADGES) !== '0'; } catch (e) { return true; } };
const applyRowBadges = () => document.body.classList.toggle('no-row-badges', !rowBadgesOn());
applyRowBadges();

(() => {
  const panel = document.getElementById('right-panel');
  const playbar = document.getElementById('playbar');
  const lyricsBtn = document.getElementById('btn-toggle-lyrics-panel');
  const audio = document.querySelector('audio');
  if (!panel || !playbar || !lyricsBtn) return;

  // app.js owns the drawer state; mirror it onto <body> so the player bar can restyle itself
  const sync = () => document.body.classList.toggle('np-open', !panel.classList.contains('hidden'));
  new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['class'] });
  sync();

  const openSheet = () => { if (panel.classList.contains('hidden')) lyricsBtn.click(); };
  const closeSheet = () => { if (!panel.classList.contains('hidden')) document.getElementById('btn-close-right-panel').click(); };

  // tapping the mini player (but not its buttons) opens the sheet
  let swiped = 0;
  playbar.addEventListener('click', (e) => {
    if (document.body.classList.contains('np-open') || Date.now() - swiped < 400) return;
    if (e.target.closest('button, input, .scrubber-track-container')) return;
    openSheet();
  });

  // swipe the sheet down to close it. The sheet and its controls follow the finger 1:1 (no CSS transition
  // chasing it), and the app behind is shown while dragging (with the sheet open it is hidden to save work)
  let startX = null, startY = null, vertical = null, lastDy = 0;
  // body.np-settling (mobile.css) animates the release; while the finger moves nothing is animated
  // --np-reveal (0..1): how far the sheet is pulled down; the app behind fades in with it
  const moveSheet = (dy, animate) => {
    document.body.classList.toggle('np-settling', animate);
    for (const n of [panel, playbar]) n.style.transform = dy ? `translateY(${dy}px)` : '';
    document.body.style.setProperty('--np-reveal', String(Math.min(1, dy / (window.innerHeight * 0.6))));
  };
  const resetSheet = () => {
    document.body.classList.remove('np-settling', 'np-dragging');
    for (const n of [panel, playbar]) n.style.transform = '';
    document.body.style.removeProperty('--np-reveal');
  };
  panel.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    const lyrics = document.getElementById('lyrics-container');
    const cover = document.getElementById('cover-container');
    const busy = (lyrics && lyrics.contains(e.target) && lyrics.scrollTop > 0) || (cover && cover.contains(e.target));
    startY = busy ? null : t.clientY; // a scrolled lyrics list scrolls; the cover swipes sideways to skip
    startX = t.clientX; vertical = null; lastDy = 0;
  }, { passive: true });
  panel.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (vertical === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      vertical = dy > 0 && Math.abs(dy) > Math.abs(dx);
      if (vertical) document.body.classList.add('np-dragging');
    }
    if (!vertical) return;
    lastDy = Math.max(0, dy);
    moveSheet(lastDy, false);
  }, { passive: true });
  const endDrag = () => {
    if (startY === null) return;
    startY = null;
    if (!vertical) return;
    if (lastDy > 110) {
      // finish the slide down, then really close (the sheet then sits off screen where the slide left it)
      moveSheet(window.innerHeight, true);
      setTimeout(() => { closeSheet(); resetSheet(); }, 260);
    } else {
      moveSheet(0, true);
      setTimeout(resetSheet, 260);
    }
  };
  panel.addEventListener('touchend', endDrag);
  panel.addEventListener('touchcancel', endDrag);

  // the artist under the title in Now Playing: the sheet closes so the artist page behind it is seen; with
  // several artists ("A, B feat. C") a menu asks which one first. Runs before app.js's own click handler
  const npArtist = document.getElementById('right-panel-artist');
  if (npArtist) {
    const open = (name) => { closeSheet(); if (window.RiffCore) window.RiffCore.openArtist(name); };
    npArtist.addEventListener('click', (e) => {
      const st = window.RiffCore && window.RiffCore.state;
      const full = st && st.currentTrack && st.currentTrack.artist;
      if (!full) return;
      e.stopImmediatePropagation();
      const names = [...new Set(String(full).replace(/ /g, ' ')
        .split(/\s*(?:,|;|&|\bfeat\b\.?|\bft\b\.?|\s[xX×]\s)\s*/i)
        .map((n) => n.trim()).filter(Boolean))];
      if (names.length < 2) { open(full); return; }
      const sheet = document.createElement('div');
      sheet.className = 'row-sheet';
      sheet.innerHTML = '<div class="row-sheet-card"><div class="row-sheet-title">Artists</div><div class="row-sheet-artist"></div>'
        + names.map((n, i) => `<button type="button" data-i="${i}"></button>`).join('') + '</div>';
      sheet.querySelectorAll('button[data-i]').forEach((b) => { b.textContent = names[b.dataset.i]; });
      sheet.addEventListener('click', (ev) => {
        const b = ev.target.closest('button[data-i]');
        if (b || !ev.target.closest('.row-sheet-card')) sheet.remove();
        if (b) open(names[b.dataset.i]);
      });
      document.body.appendChild(sheet);
    }, true);
  }

  // custom background: rebuild its file URL from the app-relative path (it changes on every reinstall)
  const fixBackground = async () => {
    const vpath = localStorage.getItem('riff_bg_vpath');
    const current = localStorage.getItem('riff_bg_url') || '';
    if (!vpath || !window.electronAPI.fileUrl) return;
    if (!current) { localStorage.removeItem('riff_bg_vpath'); return; } // background was removed
    if (!current.includes(vpath.split('/').pop())) { localStorage.removeItem('riff_bg_vpath'); return; } // a different one was chosen
    const url = await window.electronAPI.fileUrl(vpath);
    if (url && url !== current) { localStorage.setItem('riff_bg_url', url); window.RiffCore.refreshBackground(); }
  };
  if (window.RiffCore) fixBackground(); else window.addEventListener('riff:ready', fixBackground, { once: true });

  // phones default to word-by-word karaoke (the Line/Word button still switches)
  const preferWordLyrics = () => {
    const st = window.RiffCore && window.RiffCore.state;
    const btn = document.getElementById('btn-lyrics-mode');
    if (st && btn && st.lyricsMode === 'line' && localStorage.getItem('riff_adv_karaoke_words') !== 'false') btn.click();
  };
  if (window.RiffCore) preferWordLyrics(); else window.addEventListener('riff:ready', preferWordLyrics, { once: true });

  // lyrics tools (edit / sync / translate / fullscreen) move up next to the Line/Word button,
  // header: a chevron to close on the left; on the right "lyrics on/off" and a menu with the lyrics tools
  // (edit, sync, translate, karaoke, word/line). The menu presses the real buttons, so their handlers keep working
  const topRow = panel.querySelector('.right-panel-header-actions');
  const closeBtn = document.getElementById('btn-close-right-panel');
  if (topRow && closeBtn) {
    closeBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    closeBtn.title = 'Close';
    const LYRICS = 'riff_np_lyrics';
    const lyricsOn = () => { try { return localStorage.getItem(LYRICS) !== '0'; } catch (e) { return true; } };
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'np-head-btn';
    toggle.id = 'np-lyrics-toggle';
    toggle.setAttribute('aria-label', 'Lyrics');
    toggle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h10M4 18h13"/></svg>';
    const applyLyrics = () => { const on = lyricsOn(); panel.classList.toggle('np-hide-lyrics', !on); toggle.classList.toggle('active', on); };
    toggle.addEventListener('click', () => {
      try { localStorage.setItem(LYRICS, lyricsOn() ? '0' : '1'); } catch (e) {}
      applyLyrics();
    });
    applyLyrics();

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'np-head-btn';
    more.id = 'np-more';
    more.setAttribute('aria-label', 'More');
    more.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
    more.addEventListener('click', () => {
      const modeBtn = document.getElementById('btn-lyrics-mode');
      const items = [
        ['btn-lyrics-mode', `Lyrics mode: ${(modeBtn && modeBtn.textContent.trim()) || 'Word'}`],
        ['btn-add-custom-lyrics', 'Edit lyrics'],
        ['btn-sync-lyrics', 'Sync lyrics'],
        ['btn-translate-lyrics', 'Translate lyrics'],
        ['btn-tv-karaoke', 'Fullscreen karaoke'],
      ].filter(([id]) => { const b = document.getElementById(id); return b && !b.classList.contains('hidden'); });
      const sheet = document.createElement('div');
      sheet.className = 'row-sheet';
      sheet.innerHTML = '<div class="row-sheet-card"><div class="row-sheet-title">Lyrics</div><div class="row-sheet-artist"></div>'
        + items.map(([id, label]) => `<button type="button" data-id="${id}">${label}</button>`).join('') + '</div>';
      sheet.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-id]');
        if (b || !e.target.closest('.row-sheet-card')) sheet.remove();
        if (b) document.getElementById(b.dataset.id).click();
      });
      document.body.appendChild(sheet);
    });
    topRow.append(toggle, more);
  }

  // like button next to the title in Now Playing (the player bar's heart is hidden on phones);
  // it presses the real one and mirrors its state
  // (and one more at the right end of the mini player)
  const realFav = document.getElementById('btn-toggle-fav');
  const favIcon = document.getElementById('fav-icon');
  const addLike = (id, parent) => {
    const like = document.createElement('button');
    like.id = id;
    like.className = 'np-like';
    like.type = 'button';
    like.setAttribute('aria-label', 'Like');
    like.innerHTML = favIcon.outerHTML.replace('id="fav-icon"', '');
    const mirror = () => { const on = favIcon.getAttribute('fill') === 'currentColor'; like.classList.toggle('on', on); like.querySelector('svg').setAttribute('fill', on ? 'currentColor' : 'none'); };
    like.addEventListener('click', () => {
      realFav.click();
      like.classList.remove('pop'); void like.offsetWidth; like.classList.add('pop');
      if (navigator.vibrate) navigator.vibrate(12);
    });
    new MutationObserver(mirror).observe(favIcon, { attributes: true, attributeFilter: ['fill'] });
    parent.appendChild(like);
    mirror();
  };
  // in Now Playing the heart sits above the song's timer on the right, so it doesn't push the title around
  const npCenter = playbar.querySelector('.playbar-center');
  if (realFav && favIcon && npCenter) addLike('np-like', npCenter);
  if (realFav && favIcon) addLike('mini-like', playbar);

  // swipe the mini player sideways to skip, like the cover in Now Playing: left = the next song (further down the
  // list), right = the previous one (straight to it, not back to the start of this one). Cover and title follow the finger.
  const miniLeft = playbar.querySelector('.playbar-left');
  if (miniLeft) {
    let x0 = null, y0 = null, dx = 0, horizontal = null;
    playbar.addEventListener('touchstart', (e) => {
      if (document.body.classList.contains('np-open') || e.target.closest('button')) { x0 = null; return; }
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; horizontal = null;
      miniLeft.style.transition = 'none';
    }, { passive: true });
    playbar.addEventListener('touchmove', (e) => {
      if (x0 === null) return;
      dx = e.touches[0].clientX - x0;
      const dy = e.touches[0].clientY - y0;
      if (horizontal === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) horizontal = Math.abs(dx) > Math.abs(dy);
      if (horizontal) { miniLeft.style.transform = `translateX(${dx}px)`; miniLeft.style.opacity = String(Math.max(0.3, 1 - Math.abs(dx) / 220)); }
    }, { passive: true });
    playbar.addEventListener('touchend', () => {
      if (x0 === null) return;
      x0 = null;
      if (horizontal) swiped = Date.now(); // the tap that ends a swipe doesn't open Now Playing
      miniLeft.style.transition = 'transform .26s cubic-bezier(.2,.8,.2,1), opacity .26s';
      if (horizontal && Math.abs(dx) > 60) {
        const dir = dx < 0 ? -1 : 1;
        miniLeft.style.transform = `translateX(${dir * 140}px)`;
        miniLeft.style.opacity = '0';
        if (navigator.vibrate) navigator.vibrate(10);
        setTimeout(() => {
          if (window.RiffCore) { if (dir < 0) window.RiffCore.next(); else window.RiffCore.prev(); }
          miniLeft.style.transition = 'none';
          miniLeft.style.transform = `translateX(${-dir * 60}px)`;
          requestAnimationFrame(() => { miniLeft.style.transition = 'transform .3s cubic-bezier(.2,.8,.2,1), opacity .3s'; miniLeft.style.transform = ''; miniLeft.style.opacity = ''; });
        }, 180);
      } else {
        miniLeft.style.transform = ''; miniLeft.style.opacity = '';
      }
    });
  }

  // slowly drifting colour glow behind Now Playing (cover colours, plain gradients: cheap to draw)
  const ambient = document.createElement('div');
  ambient.className = 'np-ambient';
  ambient.innerHTML = '<i></i><i></i><i></i>';
  panel.prepend(ambient);

  // swipe the cover left/right to skip, with the cover following your finger
  const cover = document.getElementById('cover-container');
  if (cover) {
    let x0 = null, y0 = null, dx = 0, horizontal = null;
    cover.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; horizontal = null; cover.style.transition = 'none'; }, { passive: true });
    cover.addEventListener('touchmove', (e) => {
      if (x0 === null) return;
      dx = e.touches[0].clientX - x0;
      const dy = e.touches[0].clientY - y0;
      if (horizontal === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) horizontal = Math.abs(dx) > Math.abs(dy);
      if (horizontal) cover.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
    }, { passive: true });
    cover.addEventListener('touchend', () => {
      if (x0 === null) return;
      x0 = null;
      cover.style.transition = 'transform .32s cubic-bezier(.2,.8,.2,1), opacity .32s';
      if (horizontal && Math.abs(dx) > 70) {
        const dir = dx < 0 ? -1 : 1;
        cover.style.transform = `translateX(${dir * window.innerWidth}px) rotate(${dir * 12}deg)`;
        cover.style.opacity = '0';
        if (navigator.vibrate) navigator.vibrate(10);
        setTimeout(() => {
          if (dir < 0) document.getElementById('btn-next').click(); else document.getElementById('btn-prev').click();
          cover.style.transition = 'none';
          cover.style.transform = `translateX(${-dir * 60}px)`;
          requestAnimationFrame(() => { cover.style.transition = 'transform .38s cubic-bezier(.2,.8,.2,1), opacity .38s'; cover.style.transform = ''; cover.style.opacity = ''; });
        }, 220);
      } else {
        cover.style.transform = '';
      }
    });
  }

  // mini player progress line
  if (audio) {
    const tick = () => {
      const p = audio.duration ? audio.currentTime / audio.duration : 0;
      playbar.style.setProperty('--mini-progress', String(Math.max(0, Math.min(1, p))));
    };
    audio.addEventListener('timeupdate', tick);
    audio.addEventListener('emptied', tick);
  }

  // phone-only settings in Storage: cache size limit and sharing the error log
  const storageGroup = document.querySelector('.settings-section[data-cat="storage"] .m3-group');
  if (storageGroup) {
    const limits = [['1024', '1 GB'], ['2048', '2 GB'], ['5120', '5 GB'], ['10240', '10 GB']];
    const current = localStorage.getItem('riff_cache_limit_mb') || '2048';
    const limitRow = document.createElement('div');
    limitRow.className = 'setting-item';
    limitRow.innerHTML = `
      <div class="setting-item-top" style="align-items: center;">
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <span class="setting-name">Song storage limit</span>
          <span style="font-size: calc(12px * var(--font-scale, 1)); color: var(--md-sys-color-outline);">Songs you play are kept for offline use. Over this limit, the ones played longest ago are removed.</span>
        </div>
      </div>
      <div class="theme-mode-toggle" style="margin-top: 10px;">
        ${limits.map(([v, l]) => `<button class="fps-cap-btn${v === current ? ' active' : ''}" data-limit="${v}">${l}</button>`).join('')}
      </div>`;
    limitRow.querySelectorAll('[data-limit]').forEach((b) => b.addEventListener('click', () => {
      localStorage.setItem('riff_cache_limit_mb', b.dataset.limit);
      limitRow.querySelectorAll('[data-limit]').forEach((x) => x.classList.toggle('active', x === b));
    }));
    const logRow = document.createElement('div');
    logRow.className = 'setting-item';
    logRow.innerHTML = `
      <div class="setting-item-top" style="align-items: center;">
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <span class="setting-name">Share error log</span>
          <span style="font-size: calc(12px * var(--font-scale, 1)); color: var(--md-sys-color-outline);">If something breaks, send this so it can be fixed.</span>
        </div>
        <button class="btn-pill-primary" type="button">Share</button>
      </div>`;
    logRow.querySelector('button').addEventListener('click', async () => {
      const res = await window.electronAPI.shareText('Riff error log', window.RiffLog ? window.RiffLog.text() : 'no log');
      if (res === 'copied' && window.RiffCore) window.RiffCore.toast('Log copied to clipboard', 'info');
    });
    const badgesRow = document.createElement('div');
    badgesRow.className = 'setting-item';
    badgesRow.innerHTML = `
      <div class="setting-item-top" style="align-items: center;">
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <span class="setting-name">Source and download icons</span>
          <span style="font-size: calc(12px * var(--font-scale, 1)); color: var(--md-sys-color-outline);">Next to each song in lists: where it comes from and whether it is on this phone.</span>
        </div>
        <button class="effect-switch-btn${rowBadgesOn() ? ' active' : ''}" type="button"><span class="thumb"></span></button>
      </div>`;
    const badgesSwitch = badgesRow.querySelector('button');
    badgesSwitch.addEventListener('click', () => {
      const on = !rowBadgesOn();
      try { localStorage.setItem(ROW_BADGES, on ? '1' : '0'); } catch (e) {}
      badgesSwitch.classList.toggle('active', on);
      applyRowBadges();
    });
    storageGroup.append(limitRow, badgesRow, logRow);
  }

  // artist bio is clamped to 3 lines on phones; tapping it expands / collapses
  const bio = document.getElementById('artist-profile-bio');
  if (bio) bio.addEventListener('click', () => bio.classList.toggle('expanded'));

  // tab bar counters: hide the zeros
  const markZero = (badge) => {
    const t = badge.textContent.trim();
    badge.classList.toggle('is-zero', !t || t === '0');
    badge.dataset.big = Number(t) > 99 ? '1' : ''; // shown as "99+" (mobile.css), so the badge stays icon-sized
  };
  document.querySelectorAll('.sidebar .nav-badge').forEach((badge) => {
    markZero(badge);
    new MutationObserver(() => markZero(badge)).observe(badge, { childList: true, characterData: true, subtree: true });
  });

  // settings that only make sense on desktop
  ['btn-hw-accel', 'btn-tray-on-close', 'btn-media-keys'].forEach((id) => {
    const row = document.getElementById(id) && document.getElementById(id).closest('.setting-item');
    if (row) row.style.display = 'none';
  });
})();

// search sources: a filter button next to the search bar opens the four engine buttons as a menu
(() => {
  const box = document.querySelector('.platform-switch-container');
  const pills = box && box.querySelector('.platform-pill-switch');
  if (!pills) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'platform-filter-btn';
  btn.title = 'Search sources';
  btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18l-7 8.5V19l-4 2v-7.5z"/></svg>';
  box.prepend(btn);
  const close = () => box.classList.remove('open');
  btn.addEventListener('click', (e) => { e.stopPropagation(); box.classList.toggle('open'); });
  pills.addEventListener('click', (e) => { if (e.target.closest('.platform-btn')) close(); }); // app.js switches the source
  document.addEventListener('click', (e) => { if (!box.contains(e.target)) close(); });
})();

// global search only on the home screen (see body.off-home in mobile.css)
(() => {
  const home = document.getElementById('view-discover');
  if (!home) return;
  // the main area starts right under the header: its real bottom edge, search row or not
  const bar = document.querySelector('.titlebar');
  const nav = document.querySelector('.top-nav');
  const measure = () => {
    const last = nav && getComputedStyle(nav).display !== 'none' ? nav : bar;
    if (last) document.documentElement.style.setProperty('--top-h', `${Math.round(last.getBoundingClientRect().bottom) + 6}px`);
  };
  const sync = () => { document.body.classList.toggle('off-home', !home.classList.contains('active')); measure(); };
  new MutationObserver(sync).observe(home, { attributes: true, attributeFilter: ['class'] });
  if (window.ResizeObserver) [bar, nav].forEach((n) => n && new ResizeObserver(measure).observe(n));
  window.addEventListener('resize', measure);
  sync();
})();

// the playlists sheet lives inside the tab bar in the page; inside that fixed, clipped bar iOS paints the
// sheet and the bar's own background badly, so on phones it hangs off <body> (app.js finds it by id)
(() => {
  const drawer = document.getElementById('rail-drawer');
  if (drawer) document.body.appendChild(drawer);
})();

// track rows on phones: title, one like button, and a little column - where the song comes from (top) and
// whether it is downloaded to this phone (bottom). app.js calls this for every row it builds
(() => {
  const icon = (id) => { const s = document.querySelector(`#${id} svg`); return s ? s.outerHTML : ''; };
  const SOURCES = {
    youtube: ['YouTube', icon('platform-yt')],
    ytmusic: ['YouTube Music', icon('platform-ytm')],
    soundcloud: ['SoundCloud', icon('platform-sc')],
    yandex: ['Yandex Music', icon('platform-ym')],
    local: ['My files', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'],
  };
  const ON_PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>';
  const ONLINE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 0 0 4.5 12.5 3.5 3.5 0 0 0 6.5 19z"/></svg>';
  window.RiffDecorateRow = (row, track) => {
    const p = SOURCES[track.platform] ? track.platform : 'youtube';
    const down = p === 'local' || (window.RiffIsDownloaded ? window.RiffIsDownloaded(track.id) : false);
    const col = document.createElement('div');
    col.className = 'track-row-badges';
    col.innerHTML = `<span class="trb-src" title="${SOURCES[p][0]}">${SOURCES[p][1]}</span>`
      + `<span class="trb-dl${down ? ' on' : ''}" title="${down ? 'On this phone' : 'Streams from the internet'}">${down ? ON_PHONE : ONLINE}</span>`;
    row.appendChild(col);
  };
})();

// the row's other actions (add to playlist, download, remove) are a long press away, so a row only shows the like
(() => {
  const ACTIONS = [
    ['.btn-row-add-playlist', 'Add to playlist'],
    ['.btn-row-more', 'Download & options'],
    ['.btn-row-remove-playlist', 'Remove from playlist'],
    ['.btn-row-remove-local', 'Remove from library'],
  ];
  let sheet = null;
  const close = () => { if (sheet) { sheet.remove(); sheet = null; } };
  const open = (row) => {
    const items = ACTIONS.filter(([sel]) => row.querySelector(sel));
    if (!items.length) return;
    close();
    sheet = document.createElement('div');
    sheet.className = 'row-sheet';
    sheet.innerHTML = '<div class="row-sheet-card"><div class="row-sheet-title"></div><div class="row-sheet-artist"></div>'
      + items.map(([, label], i) => `<button type="button" data-i="${i}">${label}</button>`).join('') + '</div>';
    sheet.querySelector('.row-sheet-title').textContent = row.dataset.trackTitle || '';
    sheet.querySelector('.row-sheet-artist').textContent = row.dataset.trackArtist || '';
    sheet.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (b) { const real = row.querySelector(items[b.dataset.i][0]); close(); if (real) real.click(); }
      else if (!e.target.closest('.row-sheet-card')) close();
    });
    document.body.appendChild(sheet);
    if (navigator.vibrate) navigator.vibrate(15);
  };

  let timer = null, x0 = 0, y0 = 0, fired = 0;
  const cancel = () => { clearTimeout(timer); timer = null; };
  document.addEventListener('touchstart', (e) => {
    const row = e.target.closest('.track-row');
    if (!row || e.target.closest('button')) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    cancel();
    timer = setTimeout(() => { timer = null; fired = Date.now(); open(row); }, 480);
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (timer && Math.hypot(e.touches[0].clientX - x0, e.touches[0].clientY - y0) > 10) cancel();
  }, { passive: true });
  document.addEventListener('touchend', cancel, { passive: true });
  document.addEventListener('touchcancel', cancel, { passive: true });
  // the finger lifting after a long press must not also start the song
  document.addEventListener('click', (e) => {
    if (Date.now() - fired < 700 && e.target.closest('.track-row')) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('.track-row')) e.preventDefault(); });
})();

// Big blurred backgrounds (the cover behind everything, artist/album heroes) are CSS blur(70-90px) on desktop.
// iOS redraws such a filter whenever something moves over it, e.g. the Now Playing sheet sliding down, and it
// stutters. Here each picture is blurred once into a tiny image (a few KB, cached per song/artist) and shown
// as a plain background; data-preblur turns the CSS filter off. If a picture can't be read (no CORS), the
// element simply keeps the CSS blur.
(() => {
  const TARGETS = [
    ['#cover-bg .cover-bg-layer', { sat: 1.3, light: 1 }],
    ['#artist-hero-backdrop', { sat: 1.5, light: 0.5 }],
    ['#album-hero-fx', { sat: 1.5, light: 0.5 }],
  ];
  const SIZE = 32;
  const done = new Map(); // `${url}|${sat}|${light}` -> data URL
  const urlOf = (bg) => { const m = /url\(["']?([^"')]+)["']?\)/.exec(bg || ''); return m ? m[1] : ''; };

  const boxBlur = (px, w, h, r) => {
    const out = new Float32Array(px.length);
    for (let pass = 0; pass < 2; pass++) {
      const src = pass ? out.slice() : px;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let R = 0, G = 0, B = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = pass ? x : Math.min(w - 1, Math.max(0, x + k));
          const yy = pass ? Math.min(h - 1, Math.max(0, y + k)) : y;
          const i = (yy * w + xx) * 4;
          R += src[i]; G += src[i + 1]; B += src[i + 2]; n++;
        }
        const o = (y * w + x) * 4;
        out[o] = R / n; out[o + 1] = G / n; out[o + 2] = B / n; out[o + 3] = 255;
      }
    }
    return out;
  };

  const blurred = (url, { sat, light }) => {
    const key = `${url}|${sat}|${light}`;
    if (done.has(key)) return Promise.resolve(done.get(key));
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = SIZE;
          const ctx = c.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, SIZE, SIZE); // shrinking already averages most of the detail away
          const data = ctx.getImageData(0, 0, SIZE, SIZE); // throws if the picture is cross-origin without CORS
          const px = boxBlur(data.data, SIZE, SIZE, 3);
          for (let i = 0; i < px.length; i += 4) {
            const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
            for (let k = 0; k < 3; k++) data.data[i + k] = Math.max(0, Math.min(255, (g + (px[i + k] - g) * sat) * light));
            data.data[i + 3] = 255;
          }
          ctx.putImageData(data, 0, 0);
          const out = c.toDataURL('image/png');
          if (done.size > 40) done.delete(done.keys().next().value);
          done.set(key, out);
          resolve(out);
        } catch (e) { reject(e); }
      };
      img.onerror = reject;
      img.src = url;
    });
  };

  const handle = (el, opts) => {
    const url = urlOf(el.style.backgroundImage);
    if (!url || url.startsWith('data:')) return;
    el.removeAttribute('data-preblur'); // CSS blur until the small picture is ready
    blurred(url, opts).then((data) => {
      if (urlOf(el.style.backgroundImage) !== url) return; // the picture changed meanwhile
      el.style.backgroundImage = `url("${data}")`;
      el.dataset.preblur = '1';
    }, () => {});
  };

  for (const [sel, opts] of TARGETS) {
    document.querySelectorAll(sel).forEach((el) => {
      new MutationObserver(() => handle(el, opts)).observe(el, { attributes: true, attributeFilter: ['style'] });
      handle(el, opts);
    });
  }
})();

// tab bar: every button but Settings can be hidden (Settings -> Interface -> Tab bar); Settings stays, or
// there would be no way back
(() => {
  const KEY = 'riff_tabbar_hidden';
  const BUTTONS = [
    ['nav-discover', 'Home'], ['nav-favorites', 'Favorites'], ['nav-local', 'My files'], ['nav-history', 'History'],
    ['nav-queue', 'Queue'], ['btn-toggle-playlists-drawer', 'Playlists'],
  ].filter(([id]) => document.getElementById(id));
  const hidden = () => { try { return new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch (e) { return new Set(); } };
  const apply = () => {
    const off = hidden();
    for (const [id] of BUTTONS) document.getElementById(id).classList.toggle('tab-off', off.has(id));
  };
  apply();

  const group = document.querySelector('.settings-section[data-cat="interface"] .m3-group');
  if (!group) return;
  const row = document.createElement('div');
  row.className = 'setting-item';
  row.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 2px;">
      <span class="setting-name">Tab bar</span>
      <span style="font-size: calc(12px * var(--font-scale, 1)); color: var(--md-sys-color-outline);">Tap an icon to show or hide it at the bottom.</span>
    </div>
    <div class="tabbar-chips"></div>`;
  const chips = row.querySelector('.tabbar-chips');
  for (const [id, label] of BUTTONS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tabbar-chip';
    chip.title = label;
    chip.setAttribute('aria-label', label);
    const svg = document.getElementById(id).querySelector('svg');
    chip.innerHTML = svg ? svg.outerHTML : label;
    chip.classList.toggle('active', !hidden().has(id));
    chip.addEventListener('click', () => {
      const off = hidden();
      if (off.has(id)) off.delete(id); else off.add(id);
      try { localStorage.setItem(KEY, JSON.stringify([...off])); } catch (e) {}
      chip.classList.toggle('active', !off.has(id));
      apply();
    });
    chips.appendChild(chip);
  }
  group.prepend(row);
})();

// Palette style: what it does, and why it does nothing at 0% colour intensity (the theme is then plain
// black/white/grey and has no accent to spread)
(() => {
  const row = document.getElementById('setting-palette-style');
  if (!row) return;
  const note = document.createElement('span');
  note.className = 'palette-note';
  const top = row.querySelector('.setting-item-top');
  (top || row).insertAdjacentElement('afterend', note);
  window.addEventListener('riff:theme', (e) => {
    const mono = e.detail.intensity < 8;
    row.classList.toggle('is-disabled', mono);
    note.textContent = mono
      ? 'Raise Color intensity above 0% to use it: with no colour the theme is black and white.'
      : 'How the accent colour spreads: Classic, Tonal spot (softer, tinted backgrounds), Expressive (shifted hues, coloured backgrounds), Vibrant (strongest colour), Neutral (almost grey).';
  });
})();
