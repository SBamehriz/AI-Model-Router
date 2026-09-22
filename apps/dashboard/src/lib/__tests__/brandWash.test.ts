import { describe, it, expect } from 'vitest';
// Read as an asset, so this stays inside the browser tsconfig rather than
// pulling node types into an app that never runs on a server.
import css from '../../index.css?raw';

/**
 * The brand gradient tints real surfaces that carry real text, so its weight
 * is an accessibility decision, not only a visual one. These read the tokens
 * out of the stylesheet rather than restating them, so changing an alpha and
 * quietly dropping text under 4.5:1 fails here instead of in review.
 */
/** The declarations of one rule, whatever whitespace the pipeline left. */
const block = (selector: string): string => {
  const open = css.indexOf(selector);
  if (open === -1) throw new Error(`no ${selector} rule in index.css`);
  const from = css.indexOf('{', open);
  const close = css.indexOf('}', from);
  return css.slice(from, close === -1 ? undefined : close);
};

const light = block(':root');
const dark = block('.dark');

/** Channel triplets are declared once, in :root. */
const channels = (name: string): [number, number, number] => {
  const m = new RegExp(`--brand-${name}-rgb:\\s*([\\d]+) ([\\d]+) ([\\d]+)`).exec(light);
  if (!m) throw new Error(`no --brand-${name}-rgb token`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const GREEN = channels('green');
const TEAL = channels('teal');
const BLUE = channels('blue');

/**
 * The stops of --brand-gradient-text for a theme. The wordmark was once
 * pointed at the solid gradient, whose colours are tuned to be filled shapes
 * rather than letterforms, and light mode fell to about 2:1. The wash test in
 * place at the time only looked at tinted surfaces, so nothing caught it.
 */
const textStops = (scope: string): Array<[number, number, number]> => {
  const declared = /--brand-gradient-text:\s*([^;]+)/.exec(scope);
  if (!declared) throw new Error('no --brand-gradient-text token');
  if (declared[1].includes('var(--brand-gradient)')) return [GREEN, TEAL, BLUE];
  return [channels('green-ink'), channels('teal-ink'), channels('blue-ink')];
};

/** The three alphas of one wash token, in stop order. */
const washAlphas = (scope: string, token: string): number[] => {
  const m = new RegExp(`--${token}:\\s*linear-gradient\\(([^;]+)\\)`).exec(scope);
  if (!m) return [];
  return [...m[1].matchAll(/\/\s*(\.?\d+(?:\.\d+)?)/g)].map((a) => Number(a[1]));
};

const hsl = (h: number, s: number, l: number): [number, number, number] => {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
};
const over = (fg: number[], alpha: number, bg: number[]) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));
const luminance = (rgb: number[]) => {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};

/** Worst contrast across every stop of the gradient, not just its midpoint. */
const worstAcrossWash = (text: number[], base: number[], alphas: number[]) =>
  Math.min(...[GREEN, TEAL, BLUE].map((hue, i) => contrast(text, over(hue, alphas[i], base))));

describe('brand wash tokens', () => {
  it('declares both weights in both themes', () => {
    expect(washAlphas(light, 'brand-wash')).toHaveLength(3);
    expect(washAlphas(light, 'brand-wash-strong')).toHaveLength(3);
    expect(washAlphas(dark, 'brand-wash')).toHaveLength(3);
    expect(washAlphas(dark, 'brand-wash-strong')).toHaveLength(3);
  });

  it('keeps the strong weight heavier than the plain one', () => {
    for (const scope of [light, dark]) {
      const plain = washAlphas(scope, 'brand-wash');
      const strong = washAlphas(scope, 'brand-wash-strong');
      strong.forEach((a, i) => expect(a).toBeGreaterThan(plain[i]));
    }
  });

  const cases: Array<[string, number[], number[], 'brand-wash' | 'brand-wash-strong', string]> = [
    ['light active nav label', hsl(166, 65, 24), hsl(150, 11, 95), 'brand-wash-strong', 'light'],
    ['dark active nav label', hsl(160, 84, 65), hsl(222, 22, 6), 'brand-wash-strong', 'dark'],
    ['light selected guide topic', hsl(167, 67, 26), hsl(220, 20, 97), 'brand-wash-strong', 'light'],
    ['dark selected guide topic', hsl(173, 80, 40), hsl(222, 20, 7), 'brand-wash-strong', 'dark'],
    ['light notice body text', hsl(220, 9, 40), hsl(220, 20, 97), 'brand-wash', 'light'],
    ['dark notice body text', hsl(215, 12, 67), hsl(222, 20, 7), 'brand-wash', 'dark'],
    ['light first metric label', hsl(220, 9, 40), hsl(0, 0, 100), 'brand-wash', 'light'],
    ['dark first metric label', hsl(215, 12, 67), hsl(222, 17, 10), 'brand-wash', 'dark'],
    ['light metric icon glyph', hsl(167, 67, 26), hsl(0, 0, 100), 'brand-wash', 'light'],
    ['dark metric icon glyph', hsl(173, 80, 40), hsl(222, 17, 10), 'brand-wash', 'dark'],
  ];

  it.each(cases)('keeps %s above 4.5:1 at every stop', (_label, text, base, token, theme) => {
    const alphas = washAlphas(theme === 'dark' ? dark : light, token);
    expect(worstAcrossWash(text, base, alphas)).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * Painted letterforms, checked at every stop. A gradient reads as one colour
   * to the eye and as three to a contrast meter, and the worst of the three is
   * the one somebody has to read.
   */
  const textCases: Array<[string, number[], string, number]> = [
    ['light wordmark on the sidebar', hsl(150, 11, 95), 'light', 4.5],
    ['dark wordmark on the sidebar', hsl(222, 22, 6), 'dark', 4.5],
    ['light lead metric figure on a card', hsl(0, 0, 100), 'light', 3],
    ['dark lead metric figure on a card', hsl(222, 17, 10), 'dark', 3],
    ['light route trace over a card', hsl(0, 0, 100), 'light', 3],
    ['dark route trace over a card', hsl(222, 17, 10), 'dark', 3],
  ];

  it.each(textCases)('keeps %s readable at every stop', (_label, base, theme, floor) => {
    const stops = textStops(theme === 'dark' ? dark : light);
    const worst = Math.min(...stops.map((stop) => contrast(stop, base)));
    expect(worst).toBeGreaterThanOrEqual(floor);
  });

  it('uses darker stops for text than for filled shapes in light mode', () => {
    // If these ever became the same token again, light mode would regress.
    const ink = textStops(light);
    expect(ink).not.toEqual([GREEN, TEAL, BLUE]);
  });

  /**
   * Painting letters with a gradient is the one thing here that has gone wrong
   * twice, and both times the rule reached somewhere nobody meant it to: once
   * by pointing the wordmark at the wrong stops, once by writing
   * `.metric:first-child dd` and painting the 12px hint beside the figure,
   * because a tile holds two of them.
   *
   * So the set of things painted this way is declared, and a new one fails
   * here until somebody adds it on purpose and measures it. The cases above
   * are that measurement; scripts/contrast-audit.mjs walks the rendered pages
   * and catches the ones a static list cannot see.
   */
  const PAINTED_WITH_A_GRADIENT = ['.brand-wordmark', '.metric:first-child .metric-figure'];

  it('paints only the declared elements with a gradient', () => {
    // Every rule whose body makes the glyphs transparent so a background shows.
    const selectors = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, , body]) => /-webkit-text-fill-color:\s*transparent/.test(body))
      .map(([, selector]) => selector.trim().split('\n').pop()!.trim());

    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(
        PAINTED_WITH_A_GRADIENT.includes(selector),
        `${selector} paints its text with a gradient but is not declared. ` +
          'Add it to PAINTED_WITH_A_GRADIENT with a contrast case above, and check ' +
          'it does not match more elements than intended.',
      ).toBe(true);
    }
  });

  it('never targets a bare dd, which would take the hint as well as the figure', () => {
    expect(css).not.toMatch(/\.metric:first-child\s+dd\s*\{/);
  });
});
