// Shared by the pet window and the picker: fetch a species model and make it render-ready.
import * as THREE from 'three';
import { GLTFLoader } from './vendor/GLTFLoader.js';

const TAURI = window.__TAURI__ || null;

/** Raw GLB bytes for a species. In a plain browser (previews) it falls back to the project's pack/ folder. */
export async function fetchModelBytes(species, shiny, form = '') {
  if (TAURI) return TAURI.core.invoke('read_model', { species, shiny, form });
  const name = (n, s) => `../pack/${String(n).padStart(4, '0')}${form}${s ? '_shiny' : ''}.glb`;
  let res = await fetch(name(species, shiny));
  if (!res.ok && shiny) res = await fetch(name(species, false));
  if (!res.ok) throw new Error(`no model for species ${species}`);
  return res.arrayBuffer();
}

export function parseGlb(bytes) {
  return new Promise((resolve, reject) => new GLTFLoader().parse(bytes, '', resolve, reject));
}

/** Lowest y (in model units) reached by the idle and walk poses; falls back to the rest pose. */
function lowestPoint(model, animations, restMin) {
  const skinned = [];
  model.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
  if (!skinned.length) return restMin;
  const mixer = new THREE.AnimationMixer(model);
  let low = restMin;
  for (const [name, times] of [['Idle', [0, 1]], ['Walk', [0, 0.15, 0.3, 0.45]]]) {
    const clip = animations.find((a) => a.name === name);
    if (!clip) continue;
    const action = mixer.clipAction(clip);
    action.play();
    for (const t of times) {
      mixer.setTime(t % clip.duration);
      model.updateMatrixWorld(true);
      for (const m of skinned) m.skeleton.update();
      low = Math.min(low, new THREE.Box3().setFromObject(model, true).min.y);
    }
    action.stop();
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(model);
  return low;
}

const centreOf = (objs) => {
  const box = new THREE.Box3();
  for (const o of objs) box.expandByObject(o);
  return { c: box.getCenter(new THREE.Vector3()), s: box.getSize(new THREE.Vector3()) };
};

/**
 * Scale and ground the model, and find its blink meshes.
 *
 * Some models carry two overlapping eye meshes, eye_a (open, with pupil) and eye_b (closed);
 * the game toggles between them, and shown together eye_b hides the pupils. We only treat them as an
 * open/closed pair when they really coincide, because on other species "eye_b" can be a real second part.
 */
export const FLOOR = -0.965;   // where the soles sit in the -1..1 frustum

export function prepare(gltf, height = 1.4, floor = FLOOR, maxWide = height * 1.55) {// frustum is -1..1: this leaves ~4px under the soles in a 240px window, enough for the lying-down poses too
  const model = gltf.scene;
  const open = [], closed = [];
  model.traverse((o) => {
    const n = (o.name || '').toLowerCase();
    if (n.includes('eye_a')) open.push(o);
    else if (n.includes('eye_b')) closed.push(o);
  });
  let blink = null;
  // Library models blink by sliding the eye texture: scene extras give {materialName: [openV, closedV]}.
  const uvBlink = [];
  const lib = gltf.asset?.extras?.pokemonModelLibrary ?? {};   // embedded by the library's build_appearance_variant.py
  const spec = lib.blink;
  if (spec) {
    model.traverse((o) => {
      if (!o.isMesh) return;
      const list = [].concat(o.material);
      list.forEach((m, i) => {
        const v = spec[m.name];
        if (!v || !m.map) return;
        const c = m.clone(); c.map = m.map.clone(); c.map.needsUpdate = true;
        if (Array.isArray(o.material)) o.material[i] = c; else o.material = c;
        uvBlink.push({ tex: c.map, open: v[0], closed: v[1] });
      });
    });
  }
  if (!uvBlink.length && open.length && closed.length) {
    const a = centreOf(open), b = centreOf(closed);
    const reach = Math.max(a.s.x, a.s.y, a.s.z, 1e-6);
    if (a.c.distanceTo(b.c) < reach * 0.5) blink = { open, closed };
  }
  // Library effect "charizard-layered-fire" (metadata/effects/effect-specs.json): materials named RanchFlame* get an
  // unlit, double-sided, height-gradient shader with two drifting waves. Blue variants use the RanchFlameBlue prefix.
  const flames = [];
  if ((lib.effects ?? []).includes('charizard-layered-fire')) {
    const cache = new Map();
    model.traverse((o) => {
      if (!o.isMesh) return;
      const list = [].concat(o.material);
      list.forEach((m, i) => {
        if (!/^RanchFlame/.test(m.name || '')) return;
        if (!cache.has(m.name)) {
          const blue = m.name.startsWith('RanchFlameBlue');
          const mat = new THREE.ShaderMaterial({
            transparent: true, depthWrite: false, side: THREE.DoubleSide,
            uniforms: { t: { value: 0 }, inner: { value: new THREE.Color(blue ? 0xaefaff : 0xffeb50) }, outer: { value: new THREE.Color(blue ? 0x177dfb : 0xf34510) } },
            vertexShader: `varying vec2 vUv;
#include <common>
#include <skinning_pars_vertex>
void main(){ vUv = uv;
#include <beginnormal_vertex>
#include <skinbase_vertex>
#include <skinnormal_vertex>
#include <begin_vertex>
#include <skinning_vertex>
#include <project_vertex>
}`,
            fragmentShader: `varying vec2 vUv; uniform float t; uniform vec3 inner; uniform vec3 outer;
void main(){ float h = clamp(1.0 - vUv.y, 0.0, 1.0);
 float drift = sin(vUv.x*15.0 + h*4.0 - t*5.0)*0.09 + sin(vUv.x*24.0 - h*3.0 + t*6.8)*0.05;
 float heat = clamp(h + drift, 0.0, 1.0);
 gl_FragColor = vec4(mix(inner, outer, smoothstep(0.08, 0.83, heat)), (1.0 - smoothstep(0.67, 1.0, heat)) * 0.94); }`,
          });
          cache.set(m.name, mat);
          flames.push(mat);
        }
        if (Array.isArray(o.material)) o.material[i] = cache.get(m.name); else o.material = cache.get(m.name);
      });
    });
  }
  const tick = (seconds) => { for (const f of flames) f.uniforms.t.value = seconds; };
  // Some models (Gholdengo's board and coins) show meshes only during certain animations; their bind pose is a detached mess.
  const rules = lib.runtime?.meshVisibilityByAnimation ?? {};
  const gated = Object.entries(rules).map(([n, anims]) => [model.getObjectByName(n), new Set(anims)]).filter(([o]) => o);
  const setAnimation = (name) => { for (const [o, anims] of gated) o.visible = anims.has(name); };
  const first = lib.runtime?.defaultAnimation ?? 'Idle';
  setAnimation(first);
  // Size from the real posed bounds (precise skinned bounds in the first Idle frame). The unposed, imprecise box
  // is wrong for some skeletons (Mimikyu came out tiny).
  const idle = (gltf.animations ?? []).find((a) => a.name === first) ?? (gltf.animations ?? []).find((a) => a.name === 'Idle');
  if (idle) { const mx = new THREE.AnimationMixer(model); mx.clipAction(idle).play(); mx.update(0); }
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model, true);
  const dim = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  // Height is the usual limit; long or wide Pokemon (Charizard's tail and wings) may use more width instead of
  // shrinking to fit a square. Limited by what the window can show.
  const fit = Math.min(height / dim.y, maxWide / Math.max(dim.x, dim.z, 1e-6));
  // ...but feet go lower in the real animations than in the rest pose, so ground the model on the
  // lowest point actually reached while standing and walking.
  const lowest = lowestPoint(model, gltf.animations ?? [], box.min.y);
  model.scale.setScalar(fit);
  model.position.set(-centre.x * fit, floor - lowest * fit, -centre.z * fit);
  const setEyes = (isClosed) => {
    for (const b of uvBlink) b.tex.offset.y = isClosed ? b.closed : b.open;
    if (!blink) return;
    for (const o of blink.open) o.visible = !isClosed;
    for (const o of blink.closed) o.visible = isClosed;
  };
  setEyes(false);
  return { model, canBlink: !!blink || uvBlink.length > 0, setEyes, setAnimation, tick, drowsingEyes: lib.drowsingEyes ?? null, effects: lib.effects ?? [] };
}
