# Guide 1 — UI: Scale‑to‑Fit Layout for Webview Games (No Reflow, No Split)

**Audience:** developers on any of our webview mini‑games (games embedded in an
Android/iOS app WebView and on the website).

**Goal:** the game must look identical on every frame — tall phones, short
frames, ultra‑narrow foldables (Samsung Z Fold cover screen), and large
desktops — by keeping ONE authored design and uniformly scaling it to fit.
No responsive reflow. No splitting the layout. No squashing on a short Y axis.

---

## 1. The problem we are fixing

Most of our games were laid out responsively: the board sized off viewport
width (`vw`), and media queries rearranged the layout on small/short/landscape
frames. That breaks in two ways inside a WebView:

1. **Short Y axis** (frame not tall enough): the board keeps its width‑derived
   size, no longer fits vertically, gaps collapse, elements stretch — the UI
   looks broken.
2. **Reflow / split**: a `@media (orientation: landscape)` (or `max-height`)
   rule rearranges the design into a different layout (e.g. board on the left,
   info on the right). It no longer matches the intended design.

## 2. The principle (the fix in one sentence)

> Author the game **once** at a fixed “design canvas” size, then use a tiny bit
> of JavaScript to apply a single `transform: scale(factor)` so the whole thing
> shrinks or grows to fit the frame — preserving the exact design.

`factor = min(availableWidth / designWidth, availableHeight / designHeight)`

Because a single transform scales **everything together** (fonts, gaps, board,
buttons), proportions stay pixel‑perfect. It just gets bigger or smaller.

---

## 3. Step‑by‑step implementation

### Step 3.1 — Wrap the game in a stage + a fixed‑size design container

```html
<body>
  <div id="viewport-stage" class="viewport-stage">
    <div id="game-container" class="game-container">
      <!-- entire game UI here (header, board, footer, etc.) -->
    </div>
  </div>

  <!-- Full-screen overlays/modals live OUTSIDE the scaled container -->
  <section id="overlay" class="overlay hidden">…</section>
  <section id="result-modal" class="modal hidden">…</section>
</body>
```

- `#viewport-stage` fills the viewport and centers the game.
- `#game-container` is the **design canvas**: a fixed width, natural height.
- **Overlays/modals stay outside** the container and use `position: fixed;
  inset: 0` so they cover the real screen and are never scaled.

### Step 3.2 — CSS

```css
:root {
  /* The whole game is authored at this width and scaled to fit. */
  --design-width: 440px;   /* pick the width your design was drawn at */
  --board-size: 384px;     /* FIXED, not vw-based */
}

html, body { height: 100%; margin: 0; }

body {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  overflow: hidden;         /* the page itself never scrolls in a webview */
}

.viewport-stage {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.game-container {
  width: var(--design-width);
  flex: 0 0 auto;
  /* …the rest of your design… */
  transform-origin: center center;  /* scale around the center */
  will-change: transform;
}

/* Board (and anything previously sized in vw) uses a FIXED size now. */
.game-board {
  width: var(--board-size);
  height: var(--board-size);
}
```

Key rules:
- The container has a **fixed width** (not `width: 100%` / `max-width`).
- Anything sized in `vw`/`vh` must become a **fixed px** size — otherwise it
  fights the scaler.
- `body { overflow: hidden }` so nothing scrolls; the scaler guarantees fit.

### Step 3.3 — Remove reflow / split media queries

Delete (or neutralise) any `@media (max-width …)`, `@media (max-height …)`,
`@media (orientation: landscape)` rules that **change the layout**. The scaler
now handles all “responsiveness”. Keep only non‑layout concerns, e.g. safe
areas:

```css
/* Respect iOS notch / safe areas without changing the design. */
@supports (padding: env(safe-area-inset-top)) {
  body {
    padding:
      env(safe-area-inset-top) env(safe-area-inset-right)
      env(safe-area-inset-bottom) env(safe-area-inset-left);
  }
}
```

### Step 3.4 — The scaler (JavaScript)

```js
// viewportScaler.js
const MARGIN = 8; // breathing room around the scaled canvas (CSS px)

export function initViewportScaler(containerId = 'game-container', stageId = 'viewport-stage') {
  const container = document.getElementById(containerId);
  const stage = document.getElementById(stageId);
  if (!container) return () => {};

  let frame = null;

  const measure = () => {
    // 1) Reset transform so we read the TRUE (unscaled) design size.
    container.style.transform = 'none';
    const designW = container.offsetWidth;
    const designH = container.offsetHeight;

    // 2) Available area = the stage's client box (already excludes safe-area
    //    padding / notches). Fall back to visualViewport / window.
    let vw = stage ? stage.clientWidth : 0;
    let vh = stage ? stage.clientHeight : 0;
    if (!vw || !vh) {
      vw = (window.visualViewport && window.visualViewport.width)  || window.innerWidth;
      vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    }
    if (!designW || !designH) return;

    // 3) Uniform scale (up OR down). Never collapse to nothing.
    const scale = Math.min((vw - MARGIN * 2) / designW, (vh - MARGIN * 2) / designH);
    container.style.transform = `scale(${Math.max(scale, 0.2)})`;
  };

  const schedule = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(measure);
  };

  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', schedule);
    window.visualViewport.addEventListener('scroll', schedule);
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(schedule).observe(container);

  // Re-fit after fonts load to avoid a first-paint size jump.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule).catch(() => {});

  measure();
  return schedule; // call this after content changes that alter height
}
```

Wire it up on load, and re‑fit after any content change that changes height:

```js
window.addEventListener('load', () => {
  const refit = initViewportScaler('game-container');
  // …start your game…
  refit(); // e.g. after showing/hiding overlays, injecting player names, etc.
});
```

### Step 3.5 — Viewport meta (notch + no pinch‑zoom)

```html
<meta name="viewport"
      content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
```

---

## 4. Gotchas (learned the hard way)

- **Always reset `transform` to `none` before measuring.** If you measure while
  scaled you get the wrong design size and the scale drifts.
- **Measure the stage, not `window`.** The stage’s `clientWidth/Height`
  already accounts for safe‑area padding; measuring raw `window` can overflow
  into a notch.
- **Overlays/modals must be OUTSIDE the scaled container** (`position: fixed`),
  or they’ll shrink with the game.
- **Kill vw/vh sizing inside the canvas.** One leftover `vw` value will fight
  the scaler and reintroduce the short‑Y bug.
- **Scaling up is fine.** `min()` naturally limits growth by the smaller
  dimension, so aspect ratio is preserved even on wide desktops.
- **Fractional scale can slightly soften text** on some devices — acceptable
  and standard for this technique.
- Use `requestAnimationFrame` to coalesce resize bursts (keyboard open/close in
  webviews fires many resize events).

---

## 5. Verification (headless, before shipping)

Use a headless browser (we use Puppeteer) to screenshot the game at many
frames and eyeball that the design is identical (just scaled) with no split.

```bash
node shot.mjs <url> --out iphone.png       --size 390x844
node shot.mjs <url> --out short-land.png   --size 640x320   # the classic bug case
node shot.mjs <url> --out zfold-cover.png  --size 280x653   # ultra-narrow
node shot.mjs <url> --out zfold-open.png   --size 720x748
node shot.mjs <url> --out desktop.png      --size 1440x900  # scales UP
node shot.mjs <url> --out tall-narrow.png  --size 360x900
```

Confirm: same layout everywhere, board centered, nothing clipped, no reflow.

---

## 6. Copy‑paste checklist

- [ ] Wrap game in `#viewport-stage > #game-container`.
- [ ] Give `#game-container` a **fixed** `--design-width`; `transform-origin: center`.
- [ ] Convert all `vw`/`vh` sizes inside the canvas to **fixed px**.
- [ ] `body { overflow: hidden }`; stage is flex‑centered.
- [ ] **Delete layout‑changing media queries** (keep only safe‑area rules).
- [ ] Add `viewportScaler.js`; init on load; re‑fit after content changes.
- [ ] Viewport meta includes `viewport-fit=cover`.
- [ ] Move overlays/modals outside the container (`position: fixed`).
- [ ] Screenshot‑verify at 6+ frame sizes incl. an ultra‑narrow one.
