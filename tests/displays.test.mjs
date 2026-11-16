// node tests/displays.test.mjs   (no dependencies)
import assert from 'node:assert/strict';
import { monitorAt, floorOf, canWalkBetween, walkChain, nearestFree } from '../src/displays.js';

const mon = (id, left, top, w, h, extra = {}) => ({
  id, left, top, right: left + w, bottom: top + h,
  wl: left, wt: top, wr: left + w, wb: top + h, primary: false, ...extra,
});

// The real layout on the author's PC: two 2560x1440 side by side, and a 2560x1080 sitting above-left.
const D1 = mon(1, -2560, 0, 2560, 1440);
const D2 = mon(2, 0, 0, 2560, 1440, { primary: true });
const D3 = mon(3, -2554, -1080, 2560, 1080);
const three = [D1, D2, D3];

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok  ', name); };

test('monitorAt finds the containing monitor, including negative coordinates', () => {
  assert.equal(monitorAt(three, 100, 100).id, 2);
  assert.equal(monitorAt(three, -100, 100).id, 1);
  assert.equal(monitorAt(three, -1000, -500).id, 3);
});

test('a point in a gap or off-screen snaps to the nearest monitor', () => {
  assert.equal(monitorAt(three, 5000, 100).id, 2);
  assert.equal(monitorAt(three, -5000, 1600).id, 1);
});

test('floorOf puts a window of height h on the bottom of the work area', () => {
  assert.equal(floorOf(D2, 240), 1200);
  assert.equal(floorOf({ ...D2, wb: 1392 }, 240), 1152);   // visible 48px taskbar
});

test('equal-height side-by-side monitors are walkable, the one above is not', () => {
  assert.ok(canWalkBetween(D1, D2));
  assert.ok(canWalkBetween(D2, D1));
  assert.ok(!canWalkBetween(D3, D2));
  assert.ok(!canWalkBetween(D3, D1));
});

test('walk chain from either bottom monitor spans both, never the upper one', () => {
  for (const start of [D1, D2]) {
    const c = walkChain(three, start);
    assert.deepEqual(c.monitors.map((m) => m.id).sort(), [1, 2]);
    assert.equal(c.left, -2560);
    assert.equal(c.right, 2560);
  }
  const alone = walkChain(three, D3);
  assert.deepEqual(alone.monitors.map((m) => m.id), [3]);
});

test('a monitor with a fullscreen app is excluded from the chain', () => {
  const c = walkChain(three, D2, (m) => m.id !== 1);
  assert.deepEqual(c.monitors.map((m) => m.id), [2]);
  assert.equal(c.left, 0);
});

test('different floor lines break the chain (a visible taskbar on one monitor only)', () => {
  const taskbar = [D1, { ...D2, wb: 1392 }];
  assert.ok(!canWalkBetween(taskbar[0], taskbar[1]));
});

test('chain range uses work-area edges, so a side taskbar is not walked over', () => {
  const left = mon(1, 0, 0, 1920, 1080, { wl: 60 });
  assert.equal(walkChain([left], left).left, 60);
});

test('monitors that only touch at a corner, or are apart, are not neighbours', () => {
  const a = mon(1, 0, 0, 1000, 1000), b = mon(2, 1000, 1000, 1000, 1000), c = mon(3, 1500, 0, 1000, 1000);
  assert.ok(!canWalkBetween(a, b));
  assert.ok(!canWalkBetween(a, c));
});

test('nearestFree skips occupied monitors and itself', () => {
  const free = (occ) => (m) => !occ.includes(m.id);
  assert.equal(nearestFree(three, D2, free([])).id, 1);          // D1 is closest to D2
  assert.equal(nearestFree(three, D2, free([1])).id, 3);         // D1 busy -> the upper one
  assert.equal(nearestFree(three, D2, free([1, 3])), null);      // nowhere to go
  assert.equal(nearestFree([D2], D2, free([])), null);           // single monitor
});

console.log(`\n${n} passed`);
