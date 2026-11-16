// Monitor geometry for the pet: pure functions over a list of monitors, so they can be tested
// without a screen. Monitors look like
//   { id, left, top, right, bottom,   // full bounds
//     wl, wt, wr, wb,                 // work area (bounds minus a visible taskbar)
//     primary }
// in physical pixels, in the virtual-desktop coordinate space (can be negative).

export const SEAM = 3;        // px: two edges this close count as touching
export const FLOOR_TOL = 3;   // px: floors this close count as the same floor

/** The monitor containing the point, or the nearest one if it is in a gap or off every screen. */
export function monitorAt(monitors, x, y) {
  let best = null, bestD = Infinity;
  for (const m of monitors) {
    const dx = x < m.left ? m.left - x : x >= m.right ? x - m.right + 1 : 0;
    const dy = y < m.top ? m.top - y : y >= m.bottom ? y - m.bottom + 1 : 0;
    const d = dx * dx + dy * dy;
    if (d < bestD) { best = m; bestD = d; if (d === 0) break; }
  }
  return best;
}

/** Top of a window of height h standing on monitor m's floor (the bottom of its work area). */
export const floorOf = (m, h) => m.wb - h;

const touching = (a, b) =>
  (Math.abs(a.right - b.left) <= SEAM || Math.abs(b.right - a.left) <= SEAM) && a.top < b.bottom && b.top < a.bottom;
const sameFloor = (a, b) => Math.abs(a.wb - b.wb) <= FLOOR_TOL;

/** He can walk straight from a to b only if they touch side by side AND stand on the same floor line. */
export const canWalkBetween = (a, b) => touching(a, b) && sameFloor(a, b);

/**
 * Everything reachable on foot from `start`: monitors chained side by side on one floor line.
 * `isFree(m)` can exclude monitors he must stay off (a fullscreen app is in front there).
 * left/right are the walkable x-range of the chain (work-area edges, so he never walks over a side taskbar).
 */
export function walkChain(monitors, start, isFree = () => true) {
  const chain = [start], seen = new Set([start.id]);
  for (let i = 0; i < chain.length; i++) {
    for (const m of monitors) {
      if (!seen.has(m.id) && isFree(m) && canWalkBetween(chain[i], m)) { seen.add(m.id); chain.push(m); }
    }
  }
  return { monitors: chain, left: Math.min(...chain.map((m) => m.wl)), right: Math.max(...chain.map((m) => m.wr)) };
}

/** The free monitor closest to `from` (by centre distance), other than `from` itself; null if none. */
export function nearestFree(monitors, from, isFree) {
  const cx = (from.left + from.right) / 2, cy = (from.top + from.bottom) / 2;
  let best = null, bestD = Infinity;
  for (const m of monitors) {
    if (m.id === from.id || !isFree(m)) continue;
    const d = ((m.left + m.right) / 2 - cx) ** 2 + ((m.top + m.bottom) / 2 - cy) ** 2;
    if (d < bestD) { best = m; bestD = d; }
  }
  return best;
}
