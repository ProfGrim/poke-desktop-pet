import * as THREE from 'three';
import { fetchModelBytes, parseGlb, prepare, FLOOR } from './model.js';
import { monitorAt, floorOf, walkChain, nearestFree, reachableX } from './displays.js';

// ---------------------------------------------------------------- environment
// Inside Tauri the window itself walks around the desktop. In a plain browser
// (for previewing) the canvas is moved around the page instead.
const TAURI = window.__TAURI__ || null;
const appWindow = TAURI ? TAURI.window.getCurrentWindow() : null;
const query = new URLSearchParams(location.search);
const FPS = 30;   // draw rate; 24 or 15 would be lighter on CPU (see README "Weight")

const WIN_W = 300, WIN_H = 240;          // css px; keep in sync with tauri.conf.json
const ASPECT = WIN_W / WIN_H;

// What to show. In the app this comes from the saved settings (and changes live when the tray or
// picker changes them); in a plain browser preview it comes from ?species=212&shiny.
let species = Number(query.get('species')) || 909;
let form = query.get('form') || '';   // '' is the base form; '_f03' etc. for alternates
let shiny = query.has('shiny');
let roamEnabled = true;      // wander between monitors on his own
let chaseEnabled = true;     // now and then trot over to the mouse cursor
let overlaySetting = false;  // no free monitor: keep walking over the fullscreen app (never clickable) instead of hiding

let dpr = window.devicePixelRatio || 1;   // changes when the window is on a monitor with a different scale
const canvas = document.getElementById('c');
if (!TAURI) { canvas.style.width = WIN_W + 'px'; canvas.style.height = WIN_H + 'px'; canvas.style.position = 'fixed'; canvas.style.left = '0'; canvas.style.bottom = '0'; }

// Physical-pixel size of the window (re-read whenever it moves to a monitor with a different scale).
let size = { w: Math.round((TAURI ? innerWidth : WIN_W) * dpr), h: Math.round((TAURI ? innerHeight : WIN_H) * dpr) };

// ---------------------------------------------------------------- diagnostics
// Settings changes and every error go to pet.log in the app's data folder (%APPDATA%\dev.local.fuecocopet).
function log(kind, msg) {
  if (!TAURI) return;
  TAURI.core.invoke('log_line', { text: `${new Date().toISOString()} ${kind} ${msg}` }).catch(() => {});
}
addEventListener('error', (e) => log('error', `${e.message} @ ${e.filename}:${e.lineno}`));
addEventListener('unhandledrejection', (e) => log('rejection', String(e.reason?.stack || e.reason)));

// ---------------------------------------------------------------- monitors
// All monitors in physical pixels (see displays.js), and which of them have a fullscreen app in front.
let monitors = [];
let occupied = new Set();
let hidden = false;        // no free monitor and the overlay option is off: window hidden, nothing drawn
let overlayMode = false;   // no free monitor and the overlay option is on: visible, walking, but never clickable

const isFree = (m) => !occupied.has(m.id);
const pos = { x: 0, y: 0 };
const centre = () => ({ x: pos.x + size.w / 2, y: pos.y + size.h / 2 });
const curMon = () => { const c = centre(); return monitorAt(monitors, c.x, c.y); };
const chain = () => walkChain(monitors, curMon(), isFree);
const groundY = () => floorOf(curMon(), size.h);
const inside = (m, x, y) => x >= m.left && x < m.right && y >= m.top && y < m.bottom;

function placeOn(m, fraction = 0.5) {
  pos.x = m.wl + Math.max(0, m.wr - m.wl - size.w) * fraction;
  pos.y = floorOf(m, size.h);
}

async function setHidden(h) {
  if (h === hidden) return;
  hidden = h;
  if (!TAURI || !mixer) return;
  if (h) await appWindow.hide(); else await appWindow.show();
}

let lastSent = { x: NaN, y: NaN };
let browserBase = { x: 0, y: 0 };
function applyPosition() {
  const x = Math.round(pos.x), y = Math.round(pos.y);
  if (x === lastSent.x && y === lastSent.y) return;
  lastSent = { x, y };
  if (TAURI) appWindow.setPosition(new TAURI.dpi.PhysicalPosition(x, y));
  else canvas.style.transform = `translate(${(x - browserBase.x) / dpr}px, ${(y - browserBase.y) / dpr}px)`;
}

// ---------------------------------------------------------------- rendering
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
renderer.setPixelRatio(Math.min(dpr, 2));
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-ASPECT, ASPECT, 1, -1, 0.1, 20);
// Centred on y=0 so the frustum spans exactly -1..1: model.js grounds the feet at a fixed fraction of that.
camera.position.set(0, 0, 6);
camera.lookAt(0, 0, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a70, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(2, 4, 5);
scene.add(sun);

function resize() { renderer.setSize(canvas.clientWidth, canvas.clientHeight, false); }
addEventListener('resize', () => {
  dpr = window.devicePixelRatio || 1;       // moved to a monitor with a different scale
  renderer.setPixelRatio(Math.min(dpr, 2));
  resize();
});
resize();

// ---------------------------------------------------------------- model
const pivot = new THREE.Group();   // yaw + bounce + warp scale live here
scene.add(pivot);

// Little "Z"s that float up while he sleeps without a sleeping clip of his own (see 'dream' below).
const zGroup = new THREE.Group();
zGroup.visible = false;
scene.add(zGroup);
const zSprites = [0, 1, 2].map(() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 46px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 7; g.strokeStyle = '#3a4a78'; g.fillStyle = '#ffffff';
  g.strokeText('Z', 32, 35); g.fillText('Z', 32, 35);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  zGroup.add(sprite);
  return sprite;
});
function updateZ(on) {
  zGroup.visible = on;
  if (!on) return;
  zSprites.forEach((sp, i) => {
    const k = (pet.clock * 0.45 + i / 3) % 1;                 // each Z drifts up and fades, one third of a cycle apart
    sp.position.set(0.3 + 0.4 * k, 0.25 + 0.6 * k, 1);
    sp.scale.setScalar(0.1 + 0.13 * k);
    sp.material.opacity = Math.sin(k * Math.PI);
  });
}
let mixer = null;
const actions = {};
let current = null;

const FACE = { right: Math.PI / 2, left: -Math.PI / 2, camera: 0.45 }; // yaw per facing; tuned by eye

// Blinking, where the model has an open/closed eye pair (see prepare() in model.js).
let eyes = { canBlink: false, setEyes() {} };
let blinkIn = 3, blinkFor = 0;
function updateEyes(dt) {
  if (!eyes.canBlink) return;
  if (pet.sleeping || current === actions.Nap) { eyes.setEyes(true); return; }
  if (blinkFor > 0) { blinkFor -= dt; if (blinkFor <= 0) { eyes.setEyes(false); blinkIn = rand(2.5, 6); } return; }
  blinkIn -= dt;
  if (blinkIn <= 0) { eyes.setEyes(true); blinkFor = 0.14; }
}

let loadToken = 0;
/** Load the current species/shiny. Resolves null if a newer request started meanwhile (this one is dropped). */
async function loadModel() {
  const mine = ++loadToken;
  const gltf = await parseGlb(await fetchModelBytes(species, shiny, form));
  if (mine !== loadToken) return null;   // an older, slower load must never overwrite a newer pick
  // drop any previous model (species or shiny change)
  pivot.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [].concat(o.material ?? [])) { m.map?.dispose(); m.dispose(); }
  });
  pivot.clear();
  mixer?.stopAllAction();
  for (const k of Object.keys(actions)) delete actions[k];
  current = null;
  const prepared = prepare(gltf);
  eyes = prepared;
  pivot.add(prepared.model);
  mixer = new THREE.AnimationMixer(prepared.model);
  // Model packs name some clips differently (IdleAction, Call, Grumpy...); the behaviour below uses its own names.
  const ALIAS = { IdleAction: 'IdleA', IdleAlt: 'IdleB', Stretch: 'Shake', Call: 'Roar', Grumpy: 'Hate', Happy: 'Notice' };
  for (const clip of gltf.animations) {
    actions[clip.name] = mixer.clipAction(clip);
    if (ALIAS[clip.name] && !gltf.animations.some((c) => c.name === ALIAS[clip.name])) actions[ALIAS[clip.name]] = actions[clip.name];
  }
  mixer.addEventListener('finished', (e) => onFinished(e.action));
  return Object.keys(actions);
}

function play(name, { once = false, fade = 0.25 } = {}) {
  const next = actions[name];
  if (!next) return false;
  if (next === current && !once) return true;
  next.reset();
  next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
  next.clampWhenFinished = once;
  if (current && current !== next) next.crossFadeFrom(current, fade, false);
  next.play();
  current = next;
  eyes?.setAnimation?.(next.getClip().name);
  return true;
}

// ---------------------------------------------------------------- behaviour
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const TURN_IN_PLACE = false;   // the models' own turn clips fight the smooth turn (they swing him the wrong way first), so they stay off
const pet = { state: 'idle', timer: 0, dir: 1, target: 0, vy: 0, yaw: FACE.camera, yawGoal: FACE.camera, bounce: 0, sinceNap: 0, sleeping: false, wobble: 0, hop: 0, clock: 0, nextChase: 40, clicks: [], scale: 1, spin: 0, warp: null };

// Global cursor position (physical px), polled from Rust. Null outside Tauri.
let cursor = null;
// He only chases a cursor he can walk to: on his own monitor or one chained next to it, and never in overlay mode.
function cursorOnFloor() {
  if (overlayMode || !cursor || !monitors.length) return false;
  const here = chain();
  return here.monitors.some((m) => inside(m, cursor.x, cursor.y));
}

// A "sequence" is a short script of clips: once-through clips advance when they finish,
// looping clips (those with `dur`) advance after that many seconds.
let seq = null;
function runSeq(steps, { then = 'idle', nap = false } = {}) {
  const usable = steps.filter((s) => actions[s.clip]);
  if (!usable.length) return enter(then);
  pet.state = 'seq';
  seq = { steps: usable, i: 0, then, nap, t: 0 };
  startStep();
}
function startStep() {
  const s = seq.steps[seq.i];
  play(s.clip, { once: !s.dur });
  seq.t = s.dur || 0;
  pet.yawGoal = s.yaw ?? FACE.camera;
  if (s.bounce) pet.bounce = s.bounce;
}
function nextStep() {
  if (++seq.i >= seq.steps.length) { const then = seq.then; seq = null; enter(then); }
  else startStep();
}

/** Leave this monitor through a little spin-and-shrink and come out on `target`. */
function beginWarp(target, { fast = false } = {}) {
  if (!target || pet.state === 'warp') return;
  enter('warp', { target, fast });
}

function enter(state, arg) {
  pet.state = state;
  if (state !== 'dream') { pet.sleeping = false; if (current) current.timeScale = 1; }
  if (state !== 'happy') pet.hop = 0;
  if (state !== 'seq') seq = null;
  if (state !== 'warp') { pet.scale = 1; pet.spin = 0; pet.warp = null; }
  switch (state) {
    case 'idle':
      play('Idle');
      pet.timer = rand(4, 10);
      pet.yawGoal = FACE.camera;
      break;
    case 'walk':
    case 'run': {
      const ch = chain();
      const lo = ch.left, hi = ch.right - size.w;
      const target = arg?.x ?? rand(lo, Math.max(lo + 1, hi));
      const dir = target > pos.x ? 1 : -1;
      const turn = dir > 0 ? 'TurnRight' : 'TurnLeft';
      if (!arg?.turned && TURN_IN_PLACE && dir !== pet.dir && actions[turn]) {   // reversing: turn on the spot first, then go
        pet.pendingWalk = { x: target, turned: true, run: state === 'run' };
        pet.dir = dir;
        pet.yawGoal = dir > 0 ? FACE.right : FACE.left;
        return runSeq([{ clip: turn }], { then: 'walkturned' });
      }
      pet.target = target;
      pet.dir = dir;
      pet.yawGoal = dir > 0 ? FACE.right : FACE.left;
      play(state === 'run' && actions.Run ? 'Run' : 'Walk');
      break;
    }
    case 'walkturned': {
      const w = pet.pendingWalk ?? {};
      return enter(w.run ? 'run' : 'walk', w);
    }
    case 'roam': {
      // pick another monitor: walk there if it is chained to this one, otherwise warp
      const here = curMon();
      const options = monitors.filter((m) => m.id !== here.id && isFree(m));
      if (!options.length) return enter('walk');
      const dest = pick(options);
      if (chain().monitors.some((m) => m.id === dest.id)) {
        const span = dest.wr - dest.wl - size.w;
        return enter('walk', { x: dest.wl + rand(0.15, 0.85) * Math.max(span, 1) });
      }
      return beginWarp(dest);
    }
    case 'warp': {
      const w = { target: arg.target, phase: 0, t: 0, dur: arg.fast ? 0.2 : 0.4 };
      pet.warp = w;
      play('Idle');
      pet.yawGoal = FACE.camera;
      break;
    }
    case 'chase':
      if (!cursorOnFloor()) return enter('idle');
      pet.timer = 12; // give up after a while
      pet.nextChase = pet.clock + rand(90, 240);   // and don't do it again for a good while
      play(actions.Run ? 'Run' : 'Walk');
      break;
    case 'watch':
      play('Idle');
      pet.timer = rand(2, 4);
      break;
    case 'drag':
      play(actions.FallLoop ? 'FallLoop' : 'Idle'); // dangling from the cursor
      break;
    case 'fall':
      pet.vy = 0;
      play(actions.FallLoop ? 'FallLoop' : 'Idle');
      break;
    case 'nap':
      if (!actions.Nap && !actions.SleepStart) return enter('dream');   // no sleeping clip: sleep the procedural way
      runSeq([{ clip: 'Drowse' }, { clip: 'SleepStart' }, { clip: 'Nap', dur: rand(20, 45) }, { clip: 'SleepEnd' }, { clip: 'Shake' }], { nap: true });
      pet.sinceNap = 0;
      break;
    case 'eat':
      if (actions.Eat2 && Math.random() < 0.4) runSeq([{ clip: 'Eat2Start' }, { clip: 'Eat2', dur: rand(3, 6) }, { clip: 'Eat2End' }]);
      else runSeq([{ clip: 'EatStart' }, { clip: 'Eat', dur: rand(3, 6) }, { clip: 'EatEnd' }]);
      break;
    case 'rest':
      runSeq([{ clip: 'RestStart' }, { clip: 'Rest', dur: rand(5, 10) }, { clip: 'RestEnd' }]);
      break;
    case 'play':
      runSeq([{ clip: 'Play', bounce: 1 }]);
      break;
    case 'land':
      pet.bounce = 0.5;
      runSeq([{ clip: 'Land' }], { then: actions.Hate && Math.random() < 0.3 ? 'grumpy' : 'idle' });   // being dropped is annoying
      break;
    case 'happy':
      if (actions.Notice) { runSeq([{ clip: 'Notice' }], { then: 'idle' }); pet.bounce = 0.6; break; }
      play('Idle');                    // no glad clip: hop for joy instead
      pet.timer = 1.3;
      pet.hop = 1;
      break;
    case 'dream':                      // asleep, for models with no sleeping clip: eyes shut, slow breathing, floating Zs
      play('Idle');
      if (current) current.timeScale = 0.25;
      pet.sleeping = true;
      pet.timer = rand(20, 45);
      pet.yawGoal = FACE.camera;
      pet.sinceNap = 0;
      break;
    case 'stretch':
      if (actions.Shake) { runSeq([{ clip: 'Shake' }]); break; }
      return enter('shakeoff');
    case 'shakeoff':                   // a quick shake-off that works for any model
      play('Idle');
      pet.wobble = 1;
      pet.timer = 1.0;
      break;
    case 'lookaround':                 // glance left and right
      play('Idle');
      pet.timer = rand(3, 4.5);
      break;
    case 'grumpy':
      runSeq([{ clip: 'Hate' }]);
      break;
    case 'lonely':
      runSeq([{ clip: 'Lonely' }]);
      break;
    case 'fidget': {
      const own = ['IdleA', 'IdleB', 'Look', 'Look', 'Shake'].filter((c) => actions[c]);
      const own2 = own.length && Math.random() < 0.7;            // the model's own gestures first, a made-up one now and then
      if (own2) { runSeq([{ clip: pick(own) }]); break; }
      return enter(pick(['lookaround', 'shakeoff']));
    }
    case 'flame':
      runSeq([{ clip: 'Flame' }]);
      break;
    case 'roar':
      runSeq([{ clip: 'Roar' }]);
      break;
    case 'notice':
      runSeq([{ clip: 'Notice' }], { then: Math.random() < 0.25 ? 'watch' : 'idle' });
      break;
    case 'pounce':
      runSeq([{ clip: 'Attack' }], { then: Math.random() < 0.25 ? 'watch' : 'idle' });
      break;
  }
}

function onFinished(action) {
  if (pet.state === 'seq' && seq && !seq.steps[seq.i].dur && action === actions[seq.steps[seq.i].clip]) nextStep();
}

/** Choose what to do next. Mostly ordinary life (walking, idling, eating, napping); the mouse is a rare treat. */
function pickNext() {
  const sleepy = pet.sinceNap > 150;                       // awake a couple of minutes: napping gets likely
  const chaseOk = chaseEnabled && cursorOnFloor() && pet.clock >= pet.nextChase;
  const roamOk = roamEnabled && !overlayMode && monitors.filter(isFree).length > 1;
  const options = [
    [sleepy ? 0.30 : 0.06, 'nap'],
    [chaseOk ? 0.06 : 0, 'chase'],
    [roamOk ? 0.07 : 0, 'roam'],
    [0.20, 'walk'],
    [actions.Run ? 0.05 : 0, 'run'],
    [0.14, 'idle'],
    [0.09, 'eat'],
    [0.06, 'play'],
    [0.12, 'fidget'],
    [0.08, 'rest'],
    [actions.Flame ? 0.03 : 0, 'flame'],
    [actions.Roar ? 0.02 : 0, 'roar'],
    [actions.Lonely ? 0.02 : 0, 'lonely'],
    [actions.Hate ? 0.02 : 0, 'grumpy'],
  ];
  let roll = Math.random() * options.reduce((t, o) => t + o[0], 0);
  for (const [w, name] of options) { roll -= w; if (w > 0 && roll <= 0) return enter(name); }
  return enter('idle');
}

const easeIn = (k) => k * k;
const easeOut = (k) => 1 - (1 - k) * (1 - k);

function step(dt) {
  pet.sinceNap += dt;
  pet.clock += dt;
  const x0 = pos.x;
  switch (pet.state) {
    case 'idle':
      pet.timer -= dt;
      if (pet.timer <= 0) pickNext();
      break;
    case 'seq':
      if (seq && seq.t > 0) { seq.t -= dt; if (seq.t <= 0) nextStep(); }
      break;
    case 'walk':
    case 'run': {
      // A monitor can fill up with a game while he is on his way to it, which shrinks where he may stand.
      // Re-aim at the nearest spot he can reach, so he stops at the edge instead of pushing against it.
      pet.target = reachableX(chain(), pet.target, size.w);
      pos.x += pet.dir * (pet.state === 'run' ? 150 : 70) * dpr * dt;
      const arrived = pet.dir > 0 ? pos.x >= pet.target : pos.x <= pet.target;
      if (arrived) enter('idle');
      break;
    }
    case 'chase': {
      if (!cursorOnFloor()) return enter('idle');
      const gap = reachableX(chain(), cursor.x - size.w / 2, size.w) - pos.x;   // never aim past the edge of his floor
      pet.timer -= dt;
      if (Math.abs(gap) < 90 * dpr || pet.timer <= 0) return enter(Math.random() < 0.35 ? 'pounce' : 'notice');
      pet.dir = gap > 0 ? 1 : -1;
      pet.yawGoal = pet.dir > 0 ? FACE.right : FACE.left;
      pos.x += pet.dir * 130 * dpr * dt; // a trot, faster than a wander
      break;
    }
    case 'dream':
      pet.timer -= dt;
      if (pet.timer <= 0) enter('stretch');
      break;
    case 'happy':
    case 'shakeoff':
      pet.timer -= dt;
      if (pet.state === 'happy') pet.hop = Math.max(0, pet.timer / 1.3);   // little hops that die down
      if (pet.timer <= 0) enter('idle');
      break;
    case 'lookaround':
      pet.yawGoal = FACE.camera + Math.sin(pet.clock * 1.7) * 0.95;
      pet.timer -= dt;
      if (pet.timer <= 0) enter('idle');
      break;
    case 'watch':
      // stand there looking at the cursor, turning with it
      if (cursor) pet.yawGoal = FACE.camera + Math.max(-1, Math.min(1, (cursor.x - (pos.x + size.w / 2)) / (300 * dpr))) * 0.7;
      pet.timer -= dt;
      if (pet.timer <= 0) pickNext();
      break;
    case 'fall': {
      const fy = groundY();
      pet.vy += 2600 * dpr * dt;
      pos.y = Math.min(pos.y + pet.vy * dt, fy);
      if (pos.y >= fy) enter('land');
      break;
    }
    case 'warp': {
      const w = pet.warp;
      w.t += dt;
      const k = Math.min(1, w.t / w.dur);
      if (w.phase === 0) {
        pet.scale = Math.max(0.001, 1 - easeIn(k));
        pet.spin = k * Math.PI * 2;
        if (k >= 1) {                       // gone: reappear on the other monitor
          const m = w.target;
          placeOn(m, rand(0.12, 0.88));
          w.phase = 1; w.t = 0;
        }
      } else {
        pet.scale = Math.max(0.001, easeOut(k));
        pet.spin = (k - 1) * Math.PI * 2;
        if (k >= 1) { pet.scale = 1; pet.spin = 0; pet.bounce = 0.6; enter('play'); }
      }
      break;
    }
  }

  // Stay on the walkable strip of the monitor he is on, and on its floor. Dragging is free; a warp
  // places him itself.
  if (pet.state !== 'drag' && pet.state !== 'warp') {
    const ch = chain();
    pos.x = clamp(pos.x, ch.left, ch.right - size.w);
    if (pet.state !== 'fall') pos.y = groundY();
  }

  // Last line of defence: walking or trotting but going nowhere (pinned against an edge) for a second means stop.
  if (pet.state === 'walk' || pet.state === 'run' || pet.state === 'chase') {
    pet.stuck = Math.abs(pos.x - x0) < 0.05 * dpr ? (pet.stuck ?? 0) + dt : 0;
    if (pet.stuck > 1) { pet.stuck = 0; enter('idle'); }
  } else pet.stuck = 0;

  // smooth turn + little hop; the warp scales him about his feet
  const d = pet.yawGoal - pet.yaw;
  pet.yaw += d * Math.min(1, dt * 9);
  pivot.rotation.y = pet.yaw + pet.spin;
  pivot.rotation.z = Math.sin(pet.clock * 26) * 0.2 * pet.wobble;
  pet.wobble = Math.max(0, pet.wobble - dt * 0.9);
  const breath = pet.sleeping ? 1 + 0.02 * Math.sin(pet.clock * 1.7) : 1;
  pivot.scale.set(pet.scale, pet.scale * breath, pet.scale);
  // dozing: head drooped forward and a little sideways, nodding gently
  pivot.rotation.x = pet.sleeping ? 0.16 + 0.04 * Math.sin(pet.clock * 1.1) : 0;
  pivot.rotation.z += pet.sleeping ? 0.07 : 0;
  updateZ(pet.sleeping);
  pet.bounce = Math.max(0, pet.bounce - dt * 2.2);
  pivot.position.y = Math.abs(Math.sin(pet.bounce * Math.PI * 2)) * 0.18 * pet.bounce + Math.abs(Math.sin(pet.clock * 11)) * 0.2 * (pet.hop || 0) + FLOOR * (1 - pet.scale);
}

// ---------------------------------------------------------------- displays and fullscreen apps
/**
 * Decide where he may be, from the monitors and the fullscreen apps in front of them:
 *  - his monitor has a fullscreen app and another monitor is free: warp to the nearest free one
 *  - no monitor is free: hide, or (overlay option) stay and keep walking, never clickable
 *  - otherwise: nothing to do
 * Also runs every half second, so a drop onto a busy monitor is corrected, and when a monitor is unplugged.
 */
function evaluateDisplays(layoutChanged = false) {
  if (!monitors.length || !mixer) return;
  const c = centre();
  const here = monitorAt(monitors, c.x, c.y);
  if (layoutChanged && !inside(here, c.x, c.y)) placeOn(monitors.find((m) => m.primary) ?? monitors[0]);   // his monitor went away
  const cur = curMon();
  if (occupied.has(cur.id)) {
    const dest = nearestFree(monitors, cur, isFree);
    if (dest) {
      overlayMode = false;
      setHidden(false);
      if (pet.state !== 'warp' && pet.state !== 'drag') beginWarp(dest, { fast: true });
    } else if (overlaySetting) {
      overlayMode = true;
      setHidden(false);
    } else {
      overlayMode = false;
      setHidden(true);
    }
  } else {
    overlayMode = false;
    setHidden(false);
  }
}

function applyDisplays(d) {
  if (!d?.monitors?.length) return;
  const before = monitors.map((m) => `${m.id}:${m.left},${m.top},${m.right},${m.bottom},${m.wb}`).join('|');
  monitors = d.monitors;
  occupied = new Set(d.occupied);
  evaluateDisplays(before !== monitors.map((m) => `${m.id}:${m.left},${m.top},${m.right},${m.bottom},${m.wb}`).join('|'));
}

// ---------------------------------------------------------------- pointer: click and drag
let press = null;
const readCursor = () => (TAURI ? TAURI.core.invoke('cursor_pos').then(([x, y]) => ({ x, y })) : Promise.resolve(null));

canvas.addEventListener('pointerdown', async (e) => {
  if (overlayMode || pet.state === 'warp') return;
  canvas.setPointerCapture(e.pointerId);
  const p = { wx: pos.x, wy: pos.y, moved: false, busy: false, sx: e.screenX * dpr, sy: e.screenY * dpr };
  press = p;
  // physical cursor position, so dragging stays right across monitors with different scaling
  const c = await readCursor();
  if (c && press === p) { p.sx = c.x; p.sy = c.y; }
});
canvas.addEventListener('pointermove', async (e) => {
  const p = press;
  if (!p || p.busy) return;
  p.busy = true;
  const c = (await readCursor()) ?? { x: e.screenX * dpr, y: e.screenY * dpr };
  p.busy = false;
  if (press !== p) return;
  const dx = c.x - p.sx, dy = c.y - p.sy;
  if (!p.moved && Math.hypot(dx, dy) > 6 * dpr) { p.moved = true; enter('drag'); }
  if (p.moved) { pos.x = p.wx + dx; pos.y = p.wy + dy; }
});
function release() {
  if (!press) return;
  const wasDrag = press.moved;
  press = null;
  if (wasDrag) return enter(pos.y < groundY() - 2 ? 'fall' : 'land');
  if (seq?.nap) return runSeq([{ clip: 'SleepEnd' }]);   // a click wakes him
  if (pet.state === 'dream') return enter('stretch');
  // otherwise it pets him: usually happy, but poke him over and over and he gets grumpy
  const now = pet.clock;
  pet.clicks = pet.clicks.filter((t) => now - t < 5).concat(now);
  if (pet.clicks.length >= 4 && actions.Hate) { pet.clicks = []; return enter('grumpy'); }
  enter(actions.Notice && Math.random() < 0.5 ? 'happy' : 'play');
}
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);

// ---------------------------------------------------------------- click-through
// The window ignores the mouse except where the pet's own pixels are. Hit-testing reads
// one pixel of the frame just rendered, so transparent corners never block clicks.
// In overlay mode (walking over a fullscreen app) it ignores the mouse everywhere, so a game is never disturbed.
const gl = renderer.getContext();
const px = new Uint8Array(4);
let ignoring = false;
function updateClickThrough() {
  if (!TAURI) return;
  if (overlayMode) {
    if (!ignoring) { ignoring = true; appWindow.setIgnoreCursorEvents(true); }
    return;
  }
  if (!cursor || press) return;
  const pr = renderer.getPixelRatio();
  const bw = canvas.width, bh = canvas.height;
  const lx = ((cursor.x - pos.x) / dpr) * pr;
  const ly = ((cursor.y - pos.y) / dpr) * pr;
  let hit = false;
  if (lx >= 0 && ly >= 0 && lx < bw && ly < bh) {
    gl.readPixels(Math.floor(lx), Math.floor(bh - 1 - ly), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    hit = px[3] > 16;
  }
  if (hit === ignoring) { ignoring = !hit; appWindow.setIgnoreCursorEvents(ignoring); }
}

// ---------------------------------------------------------------- settings
// Settings come from Rust (saved in AppData) and arrive live whenever the tray or picker changes them.
async function applySettings(s) {
  if (!s) return;
  roamEnabled = s.roam !== false;
  chaseEnabled = s.chase !== false;
  overlaySetting = !!s.overlay;
  if (s.species == null) return;
  const changed = !(s.species === species && (s.form || '') === form && !!s.shiny === shiny && Object.keys(actions).length);
  log('settings', `species=${s.species} shiny=${!!s.shiny} roam=${s.roam} overlay=${s.overlay} changed=${changed}`);
  if (changed) {
    species = s.species; form = s.form || ''; shiny = !!s.shiny;
    const t0 = performance.now();
    try {
      // a load that hangs must not leave the old Pokémon on screen forever: give it 20 s, then restart the page
      const stuck = new Promise((_, reject) => setTimeout(() => reject(new Error('model load timed out')), 20000));
      const names = await Promise.race([loadModel(), stuck]);
      if (names === null) { log('load', `species=${s.species} superseded by a newer request`); return; }
      log('load', `species=${s.species} shiny=${!!s.shiny} ok in ${Math.round(performance.now() - t0)} ms, ${names.length} clips`);
    } catch (e) {
      log('load', `species=${s.species} FAILED: ${e?.stack || e}`);
      console.error('could not load model', e);
      if (performance.now() > 5000) setTimeout(() => location.reload(), 300);   // restart cleanly; it reads the saved settings
      return;
    }
    enter('idle');
  }
  evaluateDisplays();
  if (TAURI && !hidden) appWindow.show();
}

// ---------------------------------------------------------------- main loop
function browserDisplays() {
  const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
  return { monitors: [{ id: 1, left: 0, top: 0, right: w, bottom: h, wl: 0, wt: 0, wr: w, wb: h, primary: true }], occupied: [] };
}

async function main() {
  if (TAURI) {
    const s = await appWindow.outerSize();
    size = { w: s.width, h: s.height };
  }
  const d = TAURI ? await TAURI.core.invoke('display_state') : browserDisplays();
  monitors = d.monitors;
  occupied = new Set(d.occupied);
  const home = monitors.find((m) => m.primary && isFree(m)) ?? monitors.find(isFree) ?? monitors.find((m) => m.primary) ?? monitors[0];
  placeOn(home, 0.6);
  browserBase = { x: pos.x, y: pos.y };
  if (TAURI) {
    // Listen first so a pick made while we start up isn't missed. On a first run there is no
    // species yet: the window stays hidden until the picker chooses one.
    await TAURI.event.listen('settings-changed', (e) => applySettings(e.payload));
    await TAURI.event.listen('displays-changed', (e) => applyDisplays(e.payload));
    await TAURI.event.listen('move-to-monitor', (e) => {
      const m = monitors.find((x) => x.id === e.payload);
      if (m && isFree(m) && mixer) { if (hidden) setHidden(false); beginWarp(m); }
    });
    await appWindow.onResized(({ payload }) => { size = { w: payload.width, h: payload.height }; });
    await applySettings(await TAURI.core.invoke('get_settings'));
  } else {
    await loadModel();
    enter('idle');
  }

  let last = performance.now(), acc = 0, lastCursorPoll = 0, lastEval = 0;
  const frame = (now) => {
    requestAnimationFrame(frame);
    if (mixer && now - lastEval > 500) {      // housekeeping twice a second, even while hidden
      lastEval = now;
      evaluateDisplays();
      if (TAURI) appWindow.outerSize().then((s) => { size = { w: s.width, h: s.height }; });
    }
    if (document.hidden || hidden) { last = now; acc = 0; return; }
    acc += now - last; last = now;
    const interval = 1000 / FPS;
    if (acc < interval - 1) return;     // -1 ms so a 60 Hz display (16.7 ms ticks) lands on every second tick
    const dt = Math.min(acc / 1000, 0.1);
    acc = Math.min(acc - interval, interval);   // keep the remainder: dropping it lets timing jitter skip every other frame
    if (!mixer) return; // no Pokémon chosen yet
    if (TAURI && now - lastCursorPoll > 80) {   // ~12 Hz is plenty for chasing and hit-testing
      lastCursorPoll = now;
      readCursor().then((c) => { cursor = c; });
    }
    step(dt);
    updateEyes(dt);
    eyes.tick?.(performance.now() / 1000);
    mixer.update(dt);
    applyPosition();
    renderer.render(scene, camera);
    updateClickThrough();
  };
  requestAnimationFrame(frame);
}
main().catch((e) => console.error('pet failed to start', e));

// Test hook: render now and report the lowest drawn row, counted up from the bottom of the window
// (0 = the bottom edge, so a small positive number is the gap under his feet; 0 means clipped).
function lowestRow() {
  renderer.render(scene, camera);
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const filled = (row) => { let n = 0; for (let x = 0; x < w; x++) if (buf[(row * w + x) * 4 + 3] > 20) n++; return n; };
  let first = -1;
  for (let row = 0; row < h && first < 0; row++) if (filled(row)) first = row;
  return { lowest: first, bottomRows: Array.from({ length: 10 }, (_, r) => filled(r)) };
}

// handy for poking at it from the console / a test harness
window.__pet = {
  enter, pet, pos, play, actions, applySettings, lowestRow, applyDisplays, beginWarp, step, tick: (dt) => { step(dt); mixer?.update(dt); },
  get species() { return species; }, get shiny() { return shiny; }, get cursor() { return cursor; }, set cursor(v) { cursor = v; },
  get ignoring() { return ignoring; }, get seq() { return seq; }, get hidden() { return hidden; },
  get overlayMode() { return overlayMode; }, get size() { return size; },
  get monitors() { return monitors; }, get occupied() { return [...occupied]; },
  get monitor() { return monitors.length ? curMon().id : null; },
  get chainIds() { return monitors.length ? chain().monitors.map((m) => m.id) : []; },
};
