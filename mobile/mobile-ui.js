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

  // swipe down on the sheet's top area to close it
  let startY = null;
  panel.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    const lyrics = document.getElementById('lyrics-container');
    startY = (lyrics && lyrics.contains(e.target) && lyrics.scrollTop > 0) ? null : t.clientY;
  }, { passive: true });
  panel.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 0) panel.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  panel.addEventListener('touchend', (e) => {
    if (startY === null) return;
    const dy = e.changedTouches[0].clientY - startY;
    panel.style.transform = '';
    startY = null;
    if (dy > 110) closeSheet();
  });

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
  // so the lyrics get that row back; same buttons, so their handlers keep working
  const tools = panel.querySelector('.lyrics-header-actions');
  const topRow = panel.querySelector('.right-panel-header-actions');
  if (tools && topRow) { topRow.prepend(tools); tools.classList.add('np-tools-moved'); }

  // like button next to the title in Now Playing (the player bar's heart is hidden on phones);
  // it presses the real one and mirrors its state
  // (and one more at the right end of the mini player)
  const realFav = document.getElementById('btn-toggle-fav');
  const favIcon = document.getElementById('fav-icon');
  const titleRow = panel.querySelector('.right-panel-title-row');
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
  if (realFav && favIcon && titleRow) addLike('np-like', titleRow);
  if (realFav && favIcon) addLike('mini-like', playbar);

  // swipe the mini player sideways to skip: left = the previous song (straight to it, not back to
  // the start of this one), right = the next one. The cover and title follow the finger.
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
          if (window.RiffCore) { if (dir < 0) window.RiffCore.prev(); else window.RiffCore.next(); }
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
    storageGroup.append(limitRow, logRow);
  }

  // artist bio is clamped to 3 lines on phones; tapping it expands / collapses
  const bio = document.getElementById('artist-profile-bio');
  if (bio) bio.addEventListener('click', () => bio.classList.toggle('expanded'));

  // tab bar counters: hide the zeros
  const markZero = (badge) => badge.classList.toggle('is-zero', !badge.textContent.trim() || badge.textContent.trim() === '0');
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
  const sync = () => document.body.classList.toggle('off-home', !home.classList.contains('active'));
  new MutationObserver(sync).observe(home, { attributes: true, attributeFilter: ['class'] });
  sync();
})();
