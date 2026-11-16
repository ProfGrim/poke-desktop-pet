import * as THREE from 'three';
import { fetchModelBytes, parseGlb, prepare } from './model.js';

const TAURI = window.__TAURI__ || null;
const $ = (id) => document.getElementById(id);
const grid = $('grid'), q = $('q'), shinyBox = $('shiny'), status = $('status'), count = $('count');

let names = {};
let models = [];                         // one per species (its base model, or its first form if the base is not installed)
let allModels = [];                      // every installed file: [{species, form, shiny, name}]
const formsOf = (sp) => allModels.filter((m) => m.species === sp);
let settings = { species: null, form: '', shiny: false };
const tiles = new Map();                 // species -> button element

const pad = (n) => String(n).padStart(4, '0');
const nameOf = (n) => names[n] || `#${n}`;

// ---------------------------------------------------------------- thumbnails
// One shared offscreen renderer draws each model's idle pose once; results are cached per species+colour.
const R = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
R.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
R.setSize(168, 168, false);
R.setClearColor(0x000000, 0);
R.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
camera.position.set(0, 0.1, 6);
camera.lookAt(0, 0.05, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a70, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(2, 4, 5);
scene.add(sun);

const cache = new Map();
let chain = Promise.resolve();           // draw one at a time; the renderer is shared

function dispose(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [].concat(o.material ?? [])) {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose();
    }
  });
}

function thumbnail(species, shiny, form = '') {
  const key = `${species}${form}:${shiny ? 1 : 0}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const job = chain.then(async () => {
    const gltf = await parseGlb(await fetchModelBytes(species, shiny, form));
    const { model } = prepare(gltf, 1.65, -0.86, 1.9);
    const holder = new THREE.Group();
    holder.rotation.y = 0.55;            // three-quarter view
    holder.add(model);
    scene.add(holder);
    const idle = gltf.animations.find((a) => a.name === 'Idle');
    if (idle) {
      const mixer = new THREE.AnimationMixer(model);
      mixer.clipAction(idle).play();
      mixer.update(0.4);
    }
    R.render(scene, camera);
    const url = R.domElement.toDataURL('image/png');
    scene.remove(holder);
    dispose(holder);
    cache.set(key, url);
    return url;
  });
  chain = job.catch(() => {});
  return job;
}

// ---------------------------------------------------------------- tiles
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    seen.unobserve(e.target);
    paint(Number(e.target.dataset.species));
  }
}, { root: document.querySelector('main'), rootMargin: '200px' });

function wantShiny(entry) { return settings.shiny && entry.shiny; }

async function paint(species) {
  const tile = tiles.get(species);
  const entry = models.find((m) => m.species === species);
  if (!tile || !entry) return;
  const shiny = wantShiny(entry);
  try {
    const url = await thumbnail(species, shiny, entry.form);
    const pic = tile.querySelector('.pic');
    if (tile.dataset.shown === `${shiny}`) return;
    pic.replaceChildren(Object.assign(new Image(), { src: url, alt: '', draggable: false }));
    tile.dataset.shown = `${shiny}`;
  } catch (err) {
    console.error('thumbnail failed', species, err);
    tile.querySelector('.pic').textContent = '?';
  }
}

function build() {
  grid.replaceChildren();
  tiles.clear();
  for (const entry of models) {
    const b = document.createElement('button');
    b.className = 'tile';
    b.type = 'button';
    b.dataset.species = entry.species;
    b.setAttribute('role', 'listitem');
    b.innerHTML = '<div class="pic"><div class="ph"></div></div><span class="nm"></span><span class="no"></span>';
    b.querySelector('.nm').textContent = nameOf(entry.species);
    b.querySelector('.no').textContent = `#${pad(entry.species)}`;
    b.addEventListener('click', () => choose(entry.species));
    tiles.set(entry.species, b);
    grid.append(b);
    seen.observe(b);
  }
  syncSelection();
  applyFilter();
}

function setModels(list) {
  allModels = list;
  const bySpecies = new Map();
  for (const m of list) if (!bySpecies.has(m.species) || m.form === '') bySpecies.set(m.species, m);
  models = [...bySpecies.values()].sort((a, b) => a.species - b.species);
}

/** "Rattata · Alola" -> "Alola"; a name without a dot is already the whole form name ("Mega Charizard X"). */
function formLabel(m) {
  if (m.form === '' && !m.name) return 'Default';
  if (m.form === '') return 'Default';
  const n = m.name || m.form;
  return n.includes(' · ') ? n.split(' · ').slice(1).join(' · ') : n;
}

function syncForms() {
  const wrap = $('formwrap'), sel = $('form');
  const list = settings.species == null ? [] : formsOf(settings.species);
  wrap.hidden = list.length < 2;
  if (wrap.hidden) return;
  sel.replaceChildren(...list.map((m) => Object.assign(document.createElement('option'), { value: m.form, textContent: formLabel(m) })));
  sel.value = list.some((m) => m.form === (settings.form || '')) ? (settings.form || '') : list[0].form;
}

function syncSelection() {
  for (const [sp, b] of tiles) b.setAttribute('aria-pressed', String(sp === settings.species));
  status.textContent = settings.species == null
    ? 'Pick one to get started.'
    : `Now walking around your desktop: ${nameOf(settings.species)}${settings.form ? ` (${formLabel(formsOf(settings.species).find((m) => m.form === settings.form) ?? { form: settings.form })})` : ''}${settings.shiny ? ' (shiny)' : ''}`;
  shinyBox.checked = !!settings.shiny;
  syncForms();
}

function applyFilter() {
  const term = q.value.trim().toLowerCase();
  let shown = 0;
  for (const [sp, b] of tiles) {
    const hit = !term || nameOf(sp).toLowerCase().includes(term) || pad(sp).includes(term.replace('#', ''));
    b.hidden = !hit;
    if (hit) shown++;
  }
  count.textContent = `${shown} of ${models.length}`;
}

// ---------------------------------------------------------------- actions
async function choose(species, form = null) {
  // a species opens on its base form when that is installed, else on its first form
  const list = formsOf(species);
  if (form == null) form = list.some((m) => m.form === '') ? '' : (list[0]?.form ?? '');
  if (!TAURI) { settings.species = species; settings.form = form; syncSelection(); return; }
  await TAURI.core.invoke('set_species', { species, form });
}

q.addEventListener('input', applyFilter);
$('form').addEventListener('change', () => choose(settings.species, $('form').value));
shinyBox.addEventListener('change', async () => {
  if (!TAURI) { settings.shiny = shinyBox.checked; syncSelection(); refreshThumbs(); return; }
  await TAURI.core.invoke('set_shiny', { on: shinyBox.checked });
});

function refreshThumbs() {
  for (const [sp, b] of tiles) { delete b.dataset.shown; if (!b.hidden) paint(sp); }
}

// ---------------------------------------------------------------- start
async function main() {
  try { names = await (await fetch('./species.json')).json(); } catch { /* names are cosmetic */ }
  if (TAURI) {
    setModels(await TAURI.core.invoke('list_models'));
    settings = await TAURI.core.invoke('get_settings');
    await TAURI.event.listen('settings-changed', (e) => {
      const shinyChanged = e.payload.shiny !== settings.shiny;
      settings = e.payload;
      syncSelection();
      if (shinyChanged) refreshThumbs();
    });
  } else {
    // plain-browser preview: list whatever is in pack/ via a manifest the dev server can't give us,
    // so probe a short list
    const found = [];
    for (const id of [6, 25, 94, 133, 143, 197, 212, 448, 700, 906, 909, 912]) {
      const r = await fetch(`../pack/${pad(id)}.glb`, { method: 'HEAD' });
      if (r.ok) found.push({ species: id, shiny: (await fetch(`../pack/${pad(id)}_shiny.glb`, { method: 'HEAD' })).ok });
    }
    setModels(found.map((f) => ({ ...f, form: '' })));
  }
  showModels();
}

function showModels() {
  const e = $('empty');
  if (!models.length) {
    e.hidden = false;
    $('grid').replaceChildren();
    e.innerHTML = '<h2>No Pokémon loaded yet</h2><p>Press <b>Load model pack…</b> and choose the pack files you were given (they end in <code>.zip</code>). You can pick both at once.</p>';
    status.textContent = 'Load a model pack to begin.';
    return;
  }
  e.hidden = true;
  build();
  // when the shiny box is on, the first paint should already be shiny
  if (!TAURI) syncSelection();
  const sel = settings.species != null ? tiles.get(settings.species) : null;
  sel?.scrollIntoView({ block: 'center' });
}
main();

$('load')?.addEventListener('click', async () => {
  if (!TAURI) return;
  const btn = $('load'); btn.disabled = true;
  try {
    const r = await TAURI.core.invoke('import_pack');
    if (r) {
      setModels(await TAURI.core.invoke('list_models'));
      showModels();
      status.textContent = `Loaded ${r.added} model files${r.skipped ? ` (${r.skipped} ignored)` : ''}. ${models.length} Pokémon available.`;
    }
  } catch (err) { status.textContent = `Could not load that pack: ${err}`; }
  btn.disabled = false;
});

window.__picker = { get models() { return models; }, get settings() { return settings; }, choose };
