/**
 * The Resonance mark and wordmark.
 *
 * The mark is a point with symmetric arcs radiating from it — a note sounding
 * and the room answering. Drawn on a 24-unit grid from circle geometry only,
 * so it stays crisp from a 16px favicon to a full-screen splash, and reads at
 * a glance without detail to lose.
 *
 * Colour is deliberately minimal: the arcs carry the single accent, the word
 * stays plain. Two inks total.
 */

/** Arc radii, outermost first. Fading opacity implies the sound travelling. */
const ARCS = [
  { r: 10.5, opacity: 0.35, width: 1.6 },
  { r: 6.75, opacity: 0.65, width: 1.75 },
];

/**
 * A vertical arc of radius `r`, drawn on the left or right of centre.
 * `sweep` flips which way it bulges.
 */
function arc(r: number, side: 'left' | 'right'): string {
  const cx = 12;
  const cy = 12;
  // Span roughly 130 degrees, centred on the horizontal axis.
  const half = 1.14; // radians
  const dir = side === 'right' ? 1 : -1;
  const x1 = cx + dir * r * Math.cos(half);
  const y1 = cy - r * Math.sin(half);
  const x2 = cx + dir * r * Math.cos(half);
  const y2 = cy + r * Math.sin(half);
  const sweep = side === 'right' ? 1 : 0;
  const f = (n: number) => Number(n.toFixed(2));
  return `M${f(x1)} ${f(y1)} A ${r} ${r} 0 0 ${sweep} ${f(x2)} ${f(y2)}`;
}

/** The mark alone — used for the tab bar, favicons and tight spaces. */
export function logoMark(size = 28, color = 'currentColor'): string {
  const arcs = ARCS.flatMap(({ r, opacity, width }) =>
    (['left', 'right'] as const).map(
      (side) =>
        `<path d="${arc(r, side)}" fill="none" stroke="${color}" stroke-width="${width}" ` +
        `stroke-linecap="round" opacity="${opacity}"/>`,
    ),
  ).join('');

  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"
    fill="none">${arcs}<circle cx="12" cy="12" r="2.6" fill="${color}"/></svg>`;
}

/**
 * The full lockup: mark plus word.
 *
 * The word is set in the system UI face at a tight tracking — the same
 * treatment Apple and Spotify use, and it means no webfont to download and no
 * flash of unstyled text.
 */
export function logoLockup(options: { size?: number } = {}): string {
  const size = options.size ?? 30;
  return `
<div class="flex items-center gap-2.5 select-none">
  <span style="color: var(--accent); display: inline-flex">${logoMark(size)}</span>
  <span class="logo-word" style="font-size: ${size * 0.8}px">Resonance</span>
</div>`;
}
