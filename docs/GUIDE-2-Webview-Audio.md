# Guide 2 — Reliable Audio for Webview Games (iOS + Android)

**Audience:** developers on any of our webview mini‑games.

**Goal:** every sound plays reliably, background music auto‑starts and loops
gaplessly, mute/unmute is instant and never “kills” the music, and it all works
inside iOS and Android app WebViews and mobile browsers.

This is the exact playbook we used to fix the Tic‑Tac‑Toe game after reports of
“some sounds don’t play”, “music doesn’t start”, “music stops after unmute”, and
“the loop has a gap”.

---

## 1. The symptoms and their root causes

| Symptom | Root cause |
|---|---|
| Some sounds don’t play (esp. ones fired by a **network event**, e.g. a move arriving over a socket) | Autoplay policy blocks `audio.play()` that isn’t tied to a **user gesture**. Network‑triggered sounds have no gesture, so they’re silently blocked. |
| BG music doesn’t auto‑start | Webviews block audible autoplay until the first gesture. |
| BG music “shows started” but is **silent on Android** | Android Chrome commonly **rejects the first `play()`** (esp. on `pointerdown`, which fires before the tap is fully “activated”). If you only try once, it never recovers. |
| Music **stops after unmute** | Mute logic resumed based on “was it playing” instead of “should it be playing” (intent). |
| Loop has a **~300 ms gap** | HTML `<audio loop>` is **not** gapless; the browser inserts a gap on replay. |

## 2. The architecture (the fix)

Build ONE `AudioManager` with these properties:

1. **Preload + decode every sound up front** into WebAudio **buffers** at page
   load — so a sound is always in memory, never “still downloading” when needed.
2. **Play through a single unlocked `AudioContext`.** Once unlocked by the first
   gesture, **every** later sound plays — including network‑triggered ones. This
   is the core fix for missing sounds.
3. **Gain graph** for volume + mute:
   `source → (per‑sound gain) → sfxGain / musicGain → masterGain → destination`.
4. **BG music = a looping `AudioBufferSourceNode`** (sample‑accurate, gapless).
5. **Persistent, multi‑gesture unlock** that keeps trying until the context is
   actually `running`, plus an `AudioContext` `statechange` fallback.
6. **Mute via masterGain** (0/1) so WebAudio music keeps running in sync; **also
   mirror mute to every HTMLAudio fallback element**, because some WebViews expose
   `AudioContext` but fail decoding individual files; **persist** the choice and
   track **intent** (`musicWanted`) separately from “currently playing”.
7. **Retry auto‑start** until the music truly plays (covers Android’s first‑try
   rejection).
8. **HTML `<audio>` fallback** for browsers without/with broken WebAudio.

---

## 3. Step‑by‑step

### Step 3.1 — Manifest, volumes, constants

```js
const MANIFEST = {
  bgMusic:      './assets/sounds/bg_music.mp3',
  place:        './assets/sounds/x_place.mp3',
  // …all your sounds…
};
const VOLUMES = { bgMusic: 0.18, place: 0.9, /* … */ };
const LOOPING = new Set(['bgMusic', 'timerWarning']);
const UNLOCK_EVENTS = ['pointerdown','touchstart','touchend','mousedown','click','keydown'];
const MUTE_KEY = 'game.muted';
```

### Step 3.2 — Build the graph, then preload+decode everything

```js
async init() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (Ctx) {
    this.ctx = new Ctx();                         // may start 'suspended' — fine
    this.master = this.ctx.createGain(); this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(this.ctx.destination);
    this.music = this.ctx.createGain(); this.music.gain.value = VOLUMES.bgMusic; // music bus level
    this.music.connect(this.master);
    this.sfx = this.ctx.createGain(); this.sfx.gain.value = 1;
    this.sfx.connect(this.master);
  }
  this.setupUnlock();
  // Preload + decode in parallel; resolve even if some fail.
  this.ready = Promise.all(Object.entries(MANIFEST).map(([n, src]) => this.preload(n, src)));
  await this.ready;
}

async preload(name, src) {
  // (1) always create an <audio> fallback element
  const el = new Audio(); el.preload = 'auto'; el.src = src;
  if (LOOPING.has(name)) el.loop = true;
  if (VOLUMES[name] != null) el.volume = VOLUMES[name];
  el.load(); this.elements[name] = el;
  // (2) fetch + decode into a WebAudio buffer (primary path)
  if (!this.ctx) return;
  try {
    const res = await fetch(src, { cache: 'force-cache' }); // audio assets may be cached
    this.buffers[name] = await this.decode(await res.arrayBuffer());
  } catch (_) { /* element fallback covers it */ }
}

// Promise + legacy-callback compatible decode (older Safari uses callbacks)
decode(arrayBuffer) {
  return new Promise((resolve, reject) => {
    const p = this.ctx.decodeAudioData(arrayBuffer, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}
```

> **Cache note:** audio files are static — cache them (`force-cache`) or, better,
> they’re already decoded into RAM after first load. This is separate from GAME
> DATA (session/API), which should be fetched `no-store` so it’s never stale.

### Step 3.3 — Persistent unlock (+ statechange fallback)

```js
setupUnlock() {
  this._unlock = () => {
    this.resume();
    if (!this.ctx || this.ctx.state === 'running') this.finishUnlock();
    // else: resume() still pending — statechange below finishes it.
  };
  UNLOCK_EVENTS.forEach(e => window.addEventListener(e, this._unlock, { passive: true }));
  if (this.ctx) this.ctx.addEventListener('statechange', () => {
    if (this.ctx.state === 'running') this.finishUnlock();
  });
}

finishUnlock() {
  if (this.unlocked) return; this.unlocked = true;
  // Prime <audio> fallbacks so later programmatic play() is allowed on iOS/Android.
  Object.entries(this.elements).forEach(([name, el]) => {
    if (LOOPING.has(name)) return;
    const prev = el.muted; el.muted = true;
    const p = el.play();
    const restore = () => { try { el.pause(); el.currentTime = 0; el.muted = prev; } catch (_) {} };
    if (p && p.then) p.then(restore, () => { el.muted = prev; }); else restore();
  });
  this.startMusic(); // this game always wants music; no-op if already playing
  UNLOCK_EVENTS.forEach(e => window.removeEventListener(e, this._unlock));
}

resume() {
  if (this.ctx && this.ctx.state !== 'running') return this.ctx.resume().catch(() => {});
  return Promise.resolve();
}
```

### Step 3.4 — Play one‑shots (buffer first, element fallback)

```js
play(name) {
  if (this.muted) return;                      // master gain would silence anyway
  if (this.ctx && this.buffers[name]) {        // primary: WebAudio buffer
    this.resume();
    const src = this.ctx.createBufferSource(); src.buffer = this.buffers[name];
    const g = this.ctx.createGain(); g.gain.value = VOLUMES[name] ?? 0.9;
    src.connect(g); g.connect(this.sfx); src.start(0); return;
  }
  const el = this.elements[name]; if (!el) return; // fallback: clone so plays overlap
  const node = el.cloneNode(true); node.volume = VOLUMES[name] ?? 0.9;
  node.play()?.catch(() => {});
}
```

### Step 3.5 — Background music: gapless loop + retry auto‑start

```js
startMusic() {
  this.musicWanted = true;
  if (this.ctx && this.buffers.bgMusic) {      // gapless buffer loop
    if (this.musicSource) return;              // already playing
    this.resume();
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffers.bgMusic; s.loop = true;
    s.connect(this.music); s.start(0); this.musicSource = s; return;
  }
  const el = this.elements.bgMusic;            // element fallback (may gap)
  if (el) { el.loop = true; el.muted = this.muted; el.play()?.catch(() => {}); }
}

stopMusic() {
  if (this.musicSource) { try { this.musicSource.stop(0); } catch (_) {} this.musicSource = null; }
  this.elements.bgMusic?.pause();
}
```

**Retry auto‑start (element‑path games / preview harnesses).** When you can’t
use buffers (e.g. a `file://` test page), the first `play()` may be rejected on
Android — so retry on every gesture until the element actually fires `playing`:

```js
const events = ['pointerdown','touchstart','touchend','click','keydown'];
const detach = () => events.forEach(e => window.removeEventListener(e, auto));
function auto() {
  resume();
  if (!musicWanted) return detach();
  if (muted) return detach();                  // unmute will start it
  bg.muted = false; bg.play()?.catch(() => {}); // keep retrying on next gesture
}
bg.addEventListener('playing', detach);        // stop retrying once it truly plays
events.forEach(e => window.addEventListener(e, auto, { passive: true }));
```

### Step 3.6 — Mute (master gain) + persistence + intent

```js
setMuted(muted) {
  this.muted = Boolean(muted);
  try { localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0'); } catch (_) {}

  if (this.master) {
    this.master.gain.value = this.muted ? 0 : 1; // instant WebAudio mute
  }

  // Always mute HTMLAudio fallbacks too. A WebView can have AudioContext but
  // still fall back to <audio> for a file whose decode failed.
  Object.values(this.elements).forEach(el => { el.muted = this.muted; });

  if (!this.ctx) {
    if (this.muted) this.stopMusic();
    else if (this.musicWanted) this.startMusic();
  } else if (!this.muted && this.musicWanted && !this.musicSource) {
    this.startMusic(); // may safely choose the HTMLAudio fallback
  }
  return this.muted;
}
```

> **The mute bugs to avoid:** never resume music based on “was it playing” — track
> **intent** (`musicWanted`) instead. Also never assume that the presence of an
> `AudioContext` means every sound is using WebAudio. A decode failure can put one
> sound on the HTMLAudio fallback, so mute must cover **both** the master gain and
> fallback elements. With the masterGain path the WebAudio source never actually
> stops, so unmute remains seamless.

### Step 3.7 — UI click feedback (synthesized, zero asset, zero latency)

```js
playClick() {
  if (this.muted || !this.ctx) return;
  this.resume();
  const t = this.ctx.currentTime;
  const osc = this.ctx.createOscillator(), g = this.ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(660, t);
  osc.frequency.exponentialRampToValueAtTime(440, t + 0.05);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.22, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  osc.connect(g); g.connect(this.sfx || this.ctx.destination);
  osc.start(t); osc.stop(t + 0.1);
}
```

Wire it to every interactive control with one delegated listener:

```js
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.board-cell, .control-btn, .mute-btn')) audio.playClick();
});
```

---

## 4. Platform notes (why the retries matter)

- **iOS Safari/WKWebView:** unlocks audio on a real gesture (`touchend`/`click`).
  A looping `<audio>` element is unreliable — prefer WebAudio buffers. Priming
  fallback elements during the first gesture matters.
- **Android Chrome:** often **rejects the first `play()`**, especially fired on
  `pointerdown`. A one‑shot fired on the later `click` works, which is why “the
  X sound plays but music doesn’t”. **Retry until it actually plays.**
- **Audible autoplay is impossible before any gesture** on every mobile
  platform. Music starting on the first tap is the correct, expected behavior.

## 5. Gapless looping & your audio files

- Code‑side is solved by looping a **WebAudio buffer** (`source.loop = true`),
  not `<audio loop>`.
- MP3 still carries **encoder padding** (silence at start/end) which can leave a
  tiny seam even with buffer looping. For a truly seamless loop:
  - export the loop as **`.ogg`** or **`.wav`** (no encoder delay), **or**
  - ensure the MP3’s loop points are clean / the seam lands on a quiet beat.

---

## 6. Verification (headless, reproduces mobile blocking)

Run headless Chromium with autoplay **blocked** and mobile emulation, expose a
tiny debug hook, then assert. (We used Puppeteer.)

```bash
# strict autoplay + mobile UA/viewport
chromium --autoplay-policy=document-user-activation-required
```

```js
// In the page, expose for testing:
window.__audio = {
  musicPlaying: () => !!am.musicSource || !am.elements.bgMusic.paused,
  muted: () => am.muted,
};
// Test sequence:
// 1) before gesture -> musicPlaying === false
// 2) synthetic click a control -> musicPlaying === true (auto-start works)
// 3) mute -> muted === true, UI aria-pressed === "true", persisted value === "1"
// 4) unmute -> muted === false, UI aria-pressed === "false", persisted value === "0"
// 5) force/observe an HTMLAudio fallback and verify it is muted too
```

For the WebAudio path, `musicPlaying` may remain `true` while muted because the
loop intentionally keeps running behind `masterGain = 0`; that is expected and
is what makes unmute seamless. Verify **audibility state** through the mute flag,
master gain, fallback-element mute state, and the UI/persisted preference rather
than assuming that a running source must stop.

---

## 7. Copy‑paste checklist

- [ ] Preload **and decode** every sound into WebAudio buffers at page load.
- [ ] One `AudioContext` with `master / music / sfx` gain nodes.
- [ ] Music bus gain = BG volume (e.g. `0.18`) — don’t play music at full volume.
- [ ] Play SFX via buffer sources through `sfx`; `<audio>` clone fallback.
- [ ] BG music = looping **buffer source** (gapless) through `music`.
- [ ] Persistent multi‑gesture unlock + `statechange` fallback + prime elements.
- [ ] Mute = `master.gain` 0/1 **plus all HTMLAudio fallback elements**; persist to localStorage.
- [ ] Track **intent** (`musicWanted`) separately from “playing”; resume by intent.
- [ ] **Retry** music auto‑start until it truly plays (Android first‑try reject).
- [ ] Synthesized UI click routed through the sfx bus.
- [ ] GAME DATA fetched `no-store`; AUDIO assets cached/preloaded.
- [ ] Verify headless with autoplay blocked + mobile emulation, then on real
      iOS and Android devices.
- [ ] For a perfect loop, export music as `.ogg`/`.wav` or clean the MP3 loop.
```
