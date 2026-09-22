/**
 * Every piece of text the dashboard paints, checked against the WCAG contrast
 * floor, on every page and in both themes.
 *
 * Two gradient-text regressions reached the interface past hand-written
 * tests, because each of those tests only covered the elements it was written
 * for. The gap was never the maths, it was the list of things being measured.
 * This walks the rendered page instead of a list, so a rule that reaches
 * somewhere nobody intended is measured too.
 *
 * Two cases the naive version of this gets wrong, and why they matter here:
 *
 *   Gradient text. `-webkit-text-fill-color: transparent` with
 *   `background-clip: text` means the painted colour is the background
 *   gradient, and `color` is only the fallback. Reading `color` reports a
 *   contrast the reader never sees. Every stop is checked, because a gradient
 *   is one colour to the eye and several to a meter.
 *
 *   Translucent layers. A tint over a card over a page is three layers, and
 *   the colour behind the text is the composite. Walking up until an opaque
 *   layer appears and compositing back down is the only way to get the real
 *   backdrop; a gradient layer branches into its stops.
 *
 * Usage: npm run test:browser, which starts a server and calls this. Or by
 * hand against a running instance: node scripts/contrast-audit.mjs <url> <key>
 *
 * Playwright resolves from the repository's own node_modules. It is a
 * development dependency; the browser binary is fetched separately with
 * `npx playwright install chromium`, so `npm run check` never needs one.
 */
import { createRequire } from 'node:module';

const BASE = process.argv[2] ?? process.env.CONTRAST_AUDIT_BASE ?? 'http://127.0.0.1:3051';
const KEY = process.argv[3] ?? process.env.CONTRAST_AUDIT_KEY ?? '';
const FROM = process.env.CONTRAST_AUDIT_PLAYWRIGHT ?? process.cwd();

let chromium;
try {
  ({ chromium } = createRequire(FROM.endsWith('/') ? FROM : `${FROM}/`)('playwright'));
} catch {
  console.error('Playwright not resolvable. Set CONTRAST_AUDIT_PLAYWRIGHT to a directory whose node_modules has it.');
  process.exit(2);
}

const PAGES = ['/', '/overview', '/analytics', '/requests', '/playground', '/models', '/settings', '/guide'];
const THEMES = ['light', 'dark'];

/**
 * How long every answer from the API takes here. The server in this run is on
 * the same machine and answers in two milliseconds, which is less than one
 * frame: the layout a page shows while it waits is never painted, so it never
 * moves, so nothing measures it. The settings page's 0.23 shift passed the
 * layout check on its first run for exactly that reason. A router on another
 * machine answers in fifty to three hundred milliseconds, and what the reader
 * sees in that gap is the thing being checked, so every answer is held for
 * longer than any paint takes.
 */
const LATENCY_MS = 400;
const API = /^https?:\/\/[^/]+\/(v1\/|admin\/|health(\?|$)|ready(\?|$))/;
const held = (answer) => async (route) => {
  await new Promise((r) => setTimeout(r, LATENCY_MS));
  // The page may have closed while the answer was held.
  try { await answer(route); } catch { /* gone */ }
};
const slow = (page) => page.route(API, held((route) => route.continue()));

/**
 * A page loaded successfully is one of the states it has, and it is the only
 * one an unattended visit ever reaches. The destructive palette exists solely
 * for the others, so walking the happy path alone never measured a single red
 * character. These force the rest: a report that failed, one that came back
 * empty, one still arriving, and a disclosure opened.
 *
 * `prepare` runs before navigation. `click` names a control to press once the
 * page has settled. A state whose answers all arrive waits for the network to
 * go quiet; one that holds or aborts an answer never reaches that, and waits
 * for the navigation alone.
 */
const STATES = [
  { name: 'loaded', pages: PAGES, prepare: slow, wait: 'networkidle' },
  {
    name: 'failed',
    pages: ['/overview', '/analytics', '/requests', '/models', '/settings'],
    // Health still answers, so the shell stays connected and the failure
    // measured is the report's own, not a router that is down.
    prepare: async (page) => {
      await slow(page);
      await page.route(/\/(v1|admin)\//, held((route) => route.abort('failed')));
    },
  },
  {
    name: 'loading',
    pages: ['/overview', '/analytics'],
    // Never resolves, so every skeleton and busy label stays on screen.
    prepare: async (page) => {
      await slow(page);
      await page.route('**/v1/**', () => {});
    },
    settle: 600,
  },
  {
    name: 'empty',
    pages: ['/analytics', '/requests'],
    prepare: async (page) => {
      await slow(page);
      await page.route('**/v1/usage**', held((route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          total_requests: 0, total_cost: 0, total_savings: 0, total_tokens: 0,
          total_tokens_input: 0, total_tokens_output: 0, avg_latency_ms: 0, success_rate: 0,
          by_source: [], by_day: [], by_model: [], by_task: [], request_id: 'empty',
        }),
      })));
    },
  },
  { name: 'expanded', pages: ['/analytics'], click: 'summary', prepare: slow, wait: 'networkidle' },
];

/**
 * Runs in the page. Returns one record per text-bearing element, with the
 * colours already resolved: the caller only does arithmetic.
 */
const COLLECT = () => {
  const parseColor = (value) => {
    const m = /rgba?\(([^)]+)\)/.exec(value || '');
    if (!m) return null;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
    return { rgb: parts.slice(0, 3), a: parts.length > 3 && !Number.isNaN(parts[3]) ? parts[3] : 1 };
  };
  /** Every colour stop of a linear-gradient, in declaration order. */
  const gradientStops = (image) => {
    if (!image || !image.includes('gradient')) return [];
    return [...image.matchAll(/rgba?\([^)]+\)/g)].map((s) => parseColor(s[0])).filter(Boolean);
  };

  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!own) continue;

    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    // Screen-reader-only text is not painted, so it has no contrast to fail.
    if (rect.width <= 2 && rect.height <= 2) continue;
    if (cs.clipPath === 'inset(50%)' || (cs.position === 'absolute' && cs.clip === 'rect(0px, 0px, 0px, 0px)')) continue;

    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    // WCAG large text: 24px, or 18.66px when bold.
    const large = size >= 24 || (size >= 18.66 && weight >= 700);

    const fill = parseColor(cs.webkitTextFillColor || cs.color);
    const painted = fill && fill.a === 0;
    const stops = gradientStops(cs.backgroundImage);
    // Transparent fill + clipped background means the gradient IS the text.
    const clipsToText = (cs.backgroundClip === 'text' || cs.webkitBackgroundClip === 'text');
    const foregrounds = painted && clipsToText && stops.length
      ? stops
      : [parseColor(cs.color)].filter(Boolean);
    if (!foregrounds.length) continue;
    // Transparent fill with nothing painting it would be invisible text, which
    // is a different defect; report it rather than silently scoring it.
    const invisible = painted && !(clipsToText && stops.length);

    // Layers from the element outward, stopping at the first opaque one.
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      const img = gradientStops(s.backgroundImage);
      // The element's own clipped-to-text gradient paints letters, not backdrop.
      const ownTextClip = node === el && clipsToText;
      if (img.length && !ownTextClip) layers.push({ kind: 'gradient', stops: img });
      const bg = parseColor(s.backgroundColor);
      if (bg && bg.a > 0) {
        layers.push({ kind: 'color', rgb: bg.rgb, a: bg.a });
        if (bg.a >= 1) break;
      }
    }
    layers.push({ kind: 'color', rgb: [255, 255, 255], a: 1 });

    out.push({
      text: el.textContent.trim().slice(0, 48).replace(/\s+/g, ' '),
      tag: el.tagName.toLowerCase(),
      cls: (el.getAttribute('class') || '').slice(0, 70),
      size, weight, large, invisible,
      foregrounds, layers,
    });
  }
  return out;
};

/**
 * A focus indicator is drawn one of two ways here: a plain outline, and, on
 * anything built from the button component, a ring, which is a box-shadow.
 * Reading only the outline reports a transparent colour for every button,
 * because Tailwind's outline-none is literally a transparent 2px outline.
 */
const FOCUS_INDICATOR = (el) => {
  const parse = (v) => {
    const m = /rgba?\(([^)]+)\)/.exec(v || '');
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return p.length < 3 ? null : { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
  };
  const cs = getComputedStyle(el);
  const layers = [];
  for (let n = el.parentElement; n; n = n.parentElement) {
    const bg = parse(getComputedStyle(n).backgroundColor);
    if (bg && bg.a > 0) { layers.push(bg); if (bg.a >= 1) break; }
  }
  let outside = [255, 255, 255];
  for (const l of layers.reverse()) outside = l.rgb.map((c, i) => c * l.a + outside[i] * (1 - l.a));

  const indicators = [];
  const oc = parse(cs.outlineColor);
  const ow = cs.outlineStyle === 'none' ? 0 : parseFloat(cs.outlineWidth) || 0;
  if (ow > 0 && oc && oc.a > 0) indicators.push({ kind: 'outline', width: ow, ...oc });
  // A ring layer carries a spread; the offset layer beside it has spread 0.
  for (const part of (cs.boxShadow || '').split(/,(?![^(]*\))/)) {
    const c = parse(part);
    const spread = [...part.matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]))[3];
    if (c && c.a > 0 && spread > 0) indicators.push({ kind: 'ring', width: spread, ...c });
  }
  return {
    tag: el.tagName.toLowerCase(),
    cls: (el.getAttribute('class') || '').slice(0, 48),
    label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
    indicators, outside,
  };
};

/**
 * What a control looks like right now, in the properties a hover style is
 * allowed to change. A link that underlines, a select whose border warms, a
 * nav item that nudges its icon and a button that lifts its shadow all answer
 * a pointer without touching background or colour, so comparing only those
 * two reports every one of them as silent. Those false positives had to be
 * weeded out by hand once; this reads all of it.
 */
const HOVER_STATE = (el) => {
  const parse = (v) => {
    const m = /rgba?\(([^)]+)\)/.exec(v || '');
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return p.length < 3 ? null : { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
  };
  const cs = getComputedStyle(el);
  const icon = el.querySelector('svg');
  const iconStyle = icon ? getComputedStyle(icon) : null;
  // The backdrop behind the control's own text, composited from itself out.
  const layers = [];
  for (let n = el; n; n = n.parentElement) {
    const bg = parse(getComputedStyle(n).backgroundColor);
    if (bg && bg.a > 0) { layers.push(bg); if (bg.a >= 1) break; }
  }
  let backdrop = [255, 255, 255];
  for (const l of layers.reverse()) backdrop = l.rgb.map((c, i) => c * l.a + backdrop[i] * (1 - l.a));
  return {
    signature: [
      cs.backgroundColor, cs.backgroundImage, cs.color, cs.boxShadow, cs.borderColor,
      cs.textDecorationLine, cs.textDecorationColor, cs.transform, cs.scale, cs.translate,
      cs.opacity, cs.outlineColor, cs.filter,
      iconStyle ? iconStyle.transform + iconStyle.scale + iconStyle.color + iconStyle.opacity : '',
    ].join('|'),
    color: parse(cs.color),
    fill: parse(cs.webkitTextFillColor),
    backdrop,
    size: parseFloat(cs.fontSize),
    weight: Number(cs.fontWeight) || 400,
    selected: el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-current') === 'page',
    hasText: (el.textContent || '').trim().length > 0,
  };
};

const lum = (rgb) => {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};
const over = (fg, alpha, bg) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));

/**
 * Every backdrop the text might sit on. Layers arrive innermost first, so they
 * composite from the back forward; a gradient layer contributes one candidate
 * per stop, because different runs of the same string sit over different ones.
 */
const backdrops = (layers) => {
  let results = [[255, 255, 255]];
  for (const layer of [...layers].reverse()) {
    const next = [];
    for (const base of results) {
      if (layer.kind === 'color') next.push(over(layer.rgb, layer.a, base));
      else for (const stop of layer.stops) next.push(over(stop.rgb, stop.a, base));
    }
    // Keep the extremes; the darkest and lightest bound every stop between them.
    results = next.length > 12
      ? [...next].sort((p, q) => lum(p) - lum(q)).filter((_, i, arr) => i === 0 || i === arr.length - 1)
      : next;
  }
  return results;
};

/**
 * Playwright downloads a browser build that matches its own version, and that
 * is what CI installs. A machine that already carries a Chromium, a container
 * image with one provisioned, points at it here rather than having no gate at
 * all. The measurements below read colour, focus, hover and layout shift,
 * which every Chromium of the last several years reports the same way.
 */
const EXECUTABLE = process.env.CONTRAST_AUDIT_CHROMIUM;

const run = async () => {
  const browser = await chromium.launch(EXECUTABLE ? { executablePath: EXECUTABLE } : {});
  if (EXECUTABLE) console.log(`browser: ${EXECUTABLE} (${browser.version()})`);
  const failures = [];
  let checked = 0;
  /** The closest any passing text came to its floor, which is the real margin. */
  let tightest = null;
  let focusChecked = 0;
  let hoverChecked = 0;
  let layoutChecked = 0;
  /** Renders that reached the end of their measurements. */
  let rendered = 0;

  for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 }, colorScheme: theme });
    // The key the theme provider actually reads. Every earlier browser script
    // wrote `theme`, which nothing reads, and the light runs only worked
    // because the provider fell back to the emulated system scheme after
    // hydration. That is also how a real flash of the wrong theme went
    // unmeasured for a long time: the fixed wait outlasted it.
    await ctx.addInitScript(([k, t]) => {
      try {
        if (k) sessionStorage.setItem('ai-model-router.api_key', k);
        localStorage.setItem('ai-model-router.theme', t);
      } catch { /* storage blocked */ }
      // Layout shift is the other thing that only happens in the gap before a
      // page settles: content arriving and moving what was already drawn.
      // Watched from before the first paint, summed the way Cumulative Layout
      // Shift is, and blamed on the elements that moved.
      // Null until the browser says it can report them. observe() ignores an
      // entry type it does not know without throwing, so an observer that
      // attached to nothing would otherwise leave an empty list that reads as
      // a page that never moved. The list exists only when the type is
      // supported, and a null is reported as a render that measured nothing.
      window.__shifts = null;
      if ((PerformanceObserver.supportedEntryTypes || []).includes('layout-shift')) {
        window.__shifts = [];
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (e.hadRecentInput) continue;
            const nodes = (e.sources || []).map((src) => src.node).filter(Boolean)
              .map((n) => `${(n.tagName || '?').toLowerCase()}${n.className && typeof n.className === 'string' ? '.' + n.className.split(' ').slice(0, 2).join('.') : ''}`);
            window.__shifts.push({ value: e.value, at: Math.round(e.startTime), nodes });
          }
        }).observe({ type: 'layout-shift', buffered: true });
      }
    }, [KEY, theme]);

    for (const state of STATES) {
      for (const path of state.pages) {
        const where = `${path}${state.name === 'loaded' ? '' : ` (${state.name})`}`;
        const page = await ctx.newPage();
        try {
          if (state.prepare) await state.prepare(page);
          await page.goto(BASE + path, { waitUntil: state.wait ?? 'commit', timeout: 45000 });
          await page.waitForTimeout(state.settle ?? 900);
          // Measure a settled frame, not whichever one a timer landed on. A
          // page mid-transition reports colours nobody is meant to read.
          await page.waitForFunction(() => document.getAnimations().length === 0, null, { timeout: 4000 }).catch(() => {});
          if (state.click) await page.locator(state.click).first().click({ timeout: 4000 }).catch(() => {});
          if (state.click) await page.waitForTimeout(400);

          {
            // A page is allowed 0.025 in total, the boundary between what a
            // reader notices and what they do not. The settings page measured
            // 0.23 before its sections held their frames while loading. Every
            // state is measured, because a slot that holds while loading and
            // then collapses on an empty or failed answer moves the page on
            // exactly the load a new user, or a user with a problem, sees.
            await page.waitForTimeout(1500);
            const shifts = await page.evaluate(() => window.__shifts);
            const total = shifts ? shifts.reduce((n, sh) => n + sh.value, 0) : 0;
            if (shifts) layoutChecked += 1;
            if (!shifts) {
              failures.push({
                theme, path: `${where} [layout shift]`, tag: 'page', cls: '', text: 'the browser did not report layout shifts, so this render measured nothing',
                size: 0, weight: 0, worst: 0, floor: 0, note: 'not observed',
              });
            } else if (total > 0.025) {
              const worst = [...shifts].sort((a, b) => b.value - a.value).slice(0, 2)
                .map((sh) => `${sh.value.toFixed(3)} at ${sh.at}ms moving ${sh.nodes.slice(0, 2).join(', ') || 'unknown'}`).join('; ');
              failures.push({
                theme, path: `${where} [layout shift]`, tag: 'page', cls: '', text: `CLS ${total.toFixed(3)}: ${worst}`,
                size: 0, weight: 0, worst: 0, floor: 0, note: 'moved after first paint',
              });
            }
          }

          const records = await page.evaluate(COLLECT);
          if (state.name !== 'loaded' && records.length === 0) {
            console.log(`  ! ${theme} ${where}: state produced no text, so it measured nothing`);
          }
          for (const r of records) {
            checked += 1;
            const floor = r.large ? 3 : 4.5;
            const bases = backdrops(r.layers);
            let worst = Infinity;
            let worstBase = null;
            for (const fg of r.foregrounds) {
              // A stop can itself be translucent over the backdrop it paints on.
              for (const base of bases) {
                const painted = fg.a < 1 ? over(fg.rgb, fg.a, base) : fg.rgb;
                const c = ratio(painted, base);
                if (c < worst) { worst = c; worstBase = base; }
              }
            }
            if (r.invisible) {
              failures.push({ theme, path: where, ...r, worst: 0, note: 'transparent fill with nothing painting it' });
            } else if (worst < floor - 0.005) {
              failures.push({ theme, path: where, ...r, worst, floor, worstBase });
            } else if (!tightest || worst - floor < tightest.margin) {
              tightest = { margin: worst - floor, worst, floor, theme, path: where, ...r, worstBase };
            }
          }
          // Focus is a colour too, and a weak indicator is as unusable as
          // weak text. Only on the loaded state: the others are the same
          // controls, and driving focus on each would multiply the run for
          // nothing.
          if (state.name === 'loaded') {
            const controls = await page.locator('button:visible, a[href]:visible, select:visible, [tabindex="0"]:visible').all();
            for (const control of controls.slice(0, 40)) {
              let ind;
              try {
                // A disabled control cannot be focused, so it has no indicator
                // to measure and is not missing one.
                if (await control.evaluate((el) => el.disabled === true)) continue;
                await control.focus();
                // The ring transitions in; measuring sooner reads a frame of
                // the animation rather than the state it settles into.
                await page.waitForTimeout(180);
                ind = await control.evaluate(FOCUS_INDICATOR);
              } catch { continue; }
              focusChecked += 1;
              let best = 0;
              let how = 'nothing painted';
              for (const layer of ind.indicators) {
                const painted = layer.a < 1 ? over(layer.rgb, layer.a, ind.outside) : layer.rgb;
                const c = ratio(painted, ind.outside);
                if (c > best) { best = c; how = `${layer.kind} ${Math.round(layer.width)}px`; }
              }
              if (best < 3) {
                failures.push({
                  theme, path: `${where} [focused]`, tag: ind.tag, cls: ind.cls, text: ind.label,
                  size: 0, weight: 0, worst: best, floor: 3, note: `focus indicator: ${how}`,
                });
              }

              // Hover: a control has to answer a pointer, and its label has
              // to stay readable on whatever it answers with. Only real
              // controls are asked. A scroll region or a chart surface is
              // focusable so a keyboard can reach it, and nobody expects it
              // to react to a pointer. A selected item is already
              // distinguished and is not required to change again.
              // Measured at rest, not while still focused from the check
              // above: a skip link is visible only under focus, and its whole
              // purpose is the keyboard, so it owes a pointer nothing.
              const isControl = await control.evaluate((el) => {
                if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
                const r = el.getBoundingClientRect();
                return ['BUTTON', 'A', 'SELECT'].includes(el.tagName) && r.width > 2 && r.height > 2;
              });
              if (!isControl) continue;
              try {
                await page.mouse.move(0, 0);
                await page.waitForTimeout(60);
                const rest = await control.evaluate(HOVER_STATE);
                await control.hover({ timeout: 1500 });
                await page.waitForTimeout(180);
                const hovered = await control.evaluate(HOVER_STATE);
                hoverChecked += 1;
                if (!rest.selected && hovered.signature === rest.signature) {
                  failures.push({
                    theme, path: `${where} [hovered]`, tag: ind.tag, cls: ind.cls, text: ind.label,
                    size: 0, weight: 0, worst: 0, floor: 0, note: 'no hover feedback: nothing changed',
                  });
                }
                const fg = hovered.fill && hovered.fill.a > 0 ? hovered.fill : hovered.color;
                if (hovered.hasText && fg) {
                  const painted = fg.a < 1 ? over(fg.rgb, fg.a, hovered.backdrop) : fg.rgb;
                  const floor = hovered.size >= 24 || (hovered.size >= 18.66 && hovered.weight >= 700) ? 3 : 4.5;
                  const c = ratio(painted, hovered.backdrop);
                  if (c < floor - 0.005) {
                    failures.push({
                      theme, path: `${where} [hovered]`, tag: ind.tag, cls: ind.cls, text: ind.label,
                      size: hovered.size, weight: hovered.weight, worst: c, floor, note: 'hovered label',
                    });
                  }
                }
              } catch { /* not hoverable here */ }
            }
          }
          rendered += 1;
        } catch (err) {
          // A render that did not finish is not a render that passed. The
          // summary used to count it anyway, from the plan rather than from
          // what happened, so a page that timed out on every load could
          // drop out of the sweep without the run saying so.
          failures.push({
            theme, path: where, tag: 'page', cls: '', text: String(err.message).split('\n')[0],
            size: 0, weight: 0, worst: 0, floor: 0, note: 'did not render',
          });
        }
        await page.close();
      }
    }
    await ctx.close();
  }
  // The first frame has to already be the right theme, on every page. One
  // index.html serves every route, so today no page can differ; this is
  // insurance against the day one does. Everything above measures a settled
  // page on purpose, which is exactly why a page that painted dark and then
  // corrected itself went unmeasured for a long time.
  //
  // The class on <html> is watched from before the page's own scripts run.
  // Two things the first version of this got wrong: the observer has to be
  // attached to the document, because <html> does not exist yet when an init
  // script runs and observing null throws silently, leaving a check that
  // passes on nothing; and a mutation is not a flash, because the provider
  // re-applies the same class on mount. A flash is the value changing after
  // the browser's first paint.
  let firstFrames = 0;
  let chromeChecked = 0;
  for (const theme of THEMES) for (const path of PAGES) {
    // The system scheme is deliberately the opposite of the stored choice, so
    // a page that trusts the system before storage is caught too.
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 }, colorScheme: theme === 'light' ? 'dark' : 'light' });
    await ctx.addInitScript((t) => {
      try { localStorage.setItem('ai-model-router.theme', t); } catch { /* storage blocked */ }
      window.__classLog = [];
      new MutationObserver((records) => {
        for (const r of records) if (r.target === document.documentElement) window.__classLog.push([performance.now(), document.documentElement.className]);
      }).observe(document, { attributes: true, subtree: true, attributeFilter: ['class'] });
    }, theme);
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: 'load', timeout: 45000 });
      await page.waitForTimeout(700);
      const r = await page.evaluate(() => {
        const paint = performance.getEntriesByType('paint').find((e) => e.name === 'first-paint')?.startTime;
        const log = window.__classLog;
        const before = log.filter(([t]) => paint !== undefined && t < paint);
        const atPaint = before.length ? before[before.length - 1][1] : null;
        const changedAfter = log.filter(([t, c]) => paint !== undefined && t >= paint && c !== atPaint).map(([t, c]) => `${c} at ${Math.round(t)}ms`);
        // The colour a phone paints its address bar. It is declared as a hex
        // in three hand-maintained places and the page background it is meant
        // to match is an hsl() custom property, so the browser resolves both
        // here rather than anyone comparing them by eye. Assigning the hex to
        // an element and reading it back is what normalises the two spellings.
        const declared = document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null;
        let chrome = null;
        if (declared) {
          const probe = document.createElement('span');
          probe.style.color = declared;
          document.body.append(probe);
          chrome = getComputedStyle(probe).color;
          probe.remove();
        }
        return {
          paint, atPaint, changedAfter, final: document.documentElement.className, observed: log.length,
          declared, chrome, surface: getComputedStyle(document.body).backgroundColor,
        };
      });
      firstFrames += 1;
      const problem =
        r.paint === undefined ? 'the browser reported no first paint, so this measured nothing'
          : r.observed === 0 ? 'the observer saw no class at all, so this measured nothing'
            : r.atPaint === null ? `nothing set the theme before first paint, so it painted with whatever <html> declares, with "${theme}" stored`
              : r.atPaint !== theme ? `painted as "${r.atPaint}" with "${theme}" stored`
              : r.changedAfter.length ? `painted as "${r.atPaint}", then ${r.changedAfter.join(', ')}`
                : null;
      if (problem) {
        failures.push({
          theme, path: `${path} [first frame]`, tag: 'html', cls: '', text: problem,
          size: 0, weight: 0, worst: 0, floor: 0, note: 'first frame',
        });
      }
      chromeChecked += 1;
      const chromeProblem =
        r.declared === null ? 'no theme-color is declared, so a phone paints its own chrome colour over the page'
          : r.chrome !== r.surface ? `theme-color is ${r.declared}, which resolves to ${r.chrome}, over a page background of ${r.surface}`
            : null;
      if (chromeProblem) {
        failures.push({
          theme, path: `${path} [browser chrome]`, tag: 'meta', cls: '', text: chromeProblem,
          size: 0, weight: 0, worst: 0, floor: 0, note: 'browser chrome',
        });
      }
    } catch (err) {
      // Same rule as the sweep above: a check that did not finish is not a
      // check that passed. This loop printed a line and moved on, and the
      // count it guards is a floor of one, so fifteen of sixteen pages could
      // time out with the run still exiting 0.
      failures.push({
        theme, path: `${path} [first frame]`, tag: 'html', cls: '', text: String(err.message).split(String.fromCharCode(10))[0],
        size: 0, weight: 0, worst: 0, floor: 0, note: 'did not render',
      });
    }
    await ctx.close();
  }
  await browser.close();

  const renders = STATES.reduce((n, s) => n + s.pages.length, 0) * THEMES.length;
  console.log(
    `\nchecked ${checked} painted text elements over ${rendered} of ${renders} renders: ` +
      `${PAGES.length} pages in ${STATES.map((s) => s.name).join(', ')} x ${THEMES.length} themes`,
  );
  console.log(`focus indicators measured: ${focusChecked}, each against the 3:1 a focus indicator needs`);
  console.log(`hover states measured: ${hoverChecked}, each for a visible answer and a readable label`);
  console.log(`first frames checked: ${firstFrames} of ${PAGES.length * THEMES.length}, each required to already be the stored theme`);
  console.log(`renders measured for layout shift: ${layoutChecked}, each allowed 0.025 in total`);
  console.log(`browser chrome colours checked: ${chromeChecked}, each required to resolve to the page background behind it`);
  // A run that measured nothing printed "every one meets its floor" once, and
  // it was true and worthless. Measuring nothing is a failure of this tool,
  // not a pass for the interface.
  if (!focusChecked || !hoverChecked || !checked || !firstFrames || !layoutChecked || !chromeChecked) {
    console.log('\nMEASURED NOTHING. The probe did not run, so this result means nothing.');
    return 2;
  }
  if (tightest) {
    console.log(
      `closest to its floor: ${tightest.worst.toFixed(2)}:1 against ${tightest.floor} ` +
        `(${tightest.theme} ${tightest.path}, ${tightest.size}px) "${tightest.text.slice(0, 40)}"`,
    );
  }
  if (!failures.length) {
    console.log('every one meets its WCAG floor');
    return 0;
  }
  // One line per distinct defect, not per occurrence: the same rule usually
  // fires on many pages and a list of repeats hides how many real ones there are.
  const seen = new Map();
  for (const f of failures) {
    // A layout or first-frame finding is about one page, so it keeps its page.
    const key = `${f.theme}|${f.tag}.${f.cls}|${f.worst.toFixed(2)}|${f.floor ? '' : f.path}`;
    if (!seen.has(key)) seen.set(key, { ...f, where: new Set() });
    seen.get(key).where.add(f.path);
  }
  console.log(`\n${failures.length} failing element(s), ${seen.size} distinct:\n`);
  for (const f of [...seen.values()].sort((a, b) => a.worst - b.worst)) {
    if (f.floor) {
      console.log(`  ${f.worst.toFixed(2)}:1 (needs ${f.floor}) ${f.theme}  <${f.tag} class="${f.cls}">`);
      console.log(`      "${f.text}"  ${f.size}px/${f.weight}${f.note ? `  [${f.note}]` : ''}`);
    } else {
      console.log(`  ${f.note} ${f.theme}`);
      console.log(`      ${f.text}`);
    }
    console.log(`      on ${[...f.where].join(', ')}`);
  }
  return 1;
};

process.exit(await run());
