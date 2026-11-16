#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{collections::HashSet, ffi::c_void, fs, path::PathBuf, sync::Mutex, time::Duration};
use tauri::{
    ipc::Response,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry,
};

// ------------------------------------------------------------------ win32

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}

#[repr(C)]
struct MonitorInfo {
    size: u32,
    monitor: Rect,
    work: Rect,
    flags: u32,
}

type MonitorEnumProc = extern "system" fn(isize, isize, *mut Rect, isize) -> i32;
type WindowEnumProc = extern "system" fn(isize, isize) -> i32;

#[link(name = "user32")]
extern "system" {
    fn GetCursorPos(p: *mut Point) -> i32;
    fn EnumDisplayMonitors(hdc: isize, clip: *const Rect, cb: MonitorEnumProc, data: isize) -> i32;
    fn GetMonitorInfoW(monitor: isize, info: *mut MonitorInfo) -> i32;
    fn EnumWindows(cb: WindowEnumProc, lparam: isize) -> i32;
    fn IsWindowVisible(hwnd: isize) -> i32;
    fn IsIconic(hwnd: isize) -> i32;
    fn IsZoomed(hwnd: isize) -> i32;
    fn GetWindowRect(hwnd: isize, r: *mut Rect) -> i32;
    fn GetWindowLongW(hwnd: isize, index: i32) -> i32;
    fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
    fn GetClassNameW(hwnd: isize, buf: *mut u16, max: i32) -> i32;
    fn MonitorFromWindow(hwnd: isize, flags: u32) -> isize;
}

#[link(name = "dwmapi")]
extern "system" {
    fn DwmGetWindowAttribute(hwnd: isize, attr: u32, pv: *mut c_void, size: u32) -> i32;
}

/// One display, in physical pixels, in virtual-desktop coordinates (can be negative).
/// `w*` is the work area (the monitor minus a visible taskbar).
#[derive(Serialize, Clone, PartialEq)]
struct Mon {
    id: i64,
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    wl: i32,
    wt: i32,
    wr: i32,
    wb: i32,
    primary: bool,
}

extern "system" fn collect_monitor(h: isize, _dc: isize, _r: *mut Rect, data: isize) -> i32 {
    let list = unsafe { &mut *(data as *mut Vec<Mon>) };
    let mut mi = MonitorInfo {
        size: std::mem::size_of::<MonitorInfo>() as u32,
        monitor: Rect::default(),
        work: Rect::default(),
        flags: 0,
    };
    if unsafe { GetMonitorInfoW(h, &mut mi) } != 0 {
        list.push(Mon {
            id: h as i64,
            left: mi.monitor.left,
            top: mi.monitor.top,
            right: mi.monitor.right,
            bottom: mi.monitor.bottom,
            wl: mi.work.left,
            wt: mi.work.top,
            wr: mi.work.right,
            wb: mi.work.bottom,
            primary: mi.flags & 1 != 0,
        });
    }
    1
}

fn list_monitors() -> Vec<Mon> {
    let mut list: Vec<Mon> = Vec::new();
    unsafe {
        EnumDisplayMonitors(0, std::ptr::null(), collect_monitor, &mut list as *mut _ as isize);
    }
    list.sort_by_key(|m| (m.left, m.top)); // a stable order, so "monitor 1, 2, 3" means the same each time
    list
}

struct Scan<'a> {
    monitors: &'a [Mon],
    pid: u32,
    decided: HashSet<i64>,
    occupied: Vec<i64>,
}

/// Called top-of-the-z-order first. For each monitor the first *big* ordinary window decides it:
/// if that window covers the monitor and has no title bar, a fullscreen app is in front there.
/// (A maximised window keeps its title bar; small floating windows are skipped so they cannot hide a game.)
extern "system" fn scan_window(h: isize, data: isize) -> i32 {
    const GWL_EXSTYLE: i32 = -20;
    const GWL_STYLE: i32 = -16;
    const WS_CAPTION: i32 = 0x00C0_0000;
    const WS_EX_TRANSPARENT: i32 = 0x20;
    const WS_EX_TOOLWINDOW: i32 = 0x80;
    const WS_EX_NOACTIVATE: i32 = 0x0800_0000;
    const DWMWA_CLOAKED: u32 = 14;
    const MONITOR_DEFAULTTONEAREST: u32 = 2;

    let s = unsafe { &mut *(data as *mut Scan) };
    unsafe {
        if IsWindowVisible(h) == 0 || IsIconic(h) != 0 {
            return 1;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, &mut pid);
        if pid == s.pid {
            return 1;
        }
        // click-through overlays, tool windows and never-activated windows are not "the app in front"
        if GetWindowLongW(h, GWL_EXSTYLE) & (WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) != 0 {
            return 1;
        }
        let mut cloaked = 0u32;
        DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, 4);
        if cloaked != 0 {
            return 1; // on another virtual desktop, or a suspended UWP shell
        }
        let mut name = [0u16; 64];
        let n = GetClassNameW(h, name.as_mut_ptr(), 64).max(0) as usize;
        match String::from_utf16_lossy(&name[..n]).as_str() {
            "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" => return 1,
            _ => {}
        }
        let mut r = Rect::default();
        if GetWindowRect(h, &mut r) == 0 {
            return 1;
        }
        let id = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST) as i64;
        let Some(m) = s.monitors.iter().find(|m| m.id == id) else { return 1 };
        if s.decided.contains(&id) {
            return 1;
        }
        let ow = (r.right.min(m.right) - r.left.max(m.left)).max(0) as i64;
        let oh = (r.bottom.min(m.bottom) - r.top.max(m.top)).max(0) as i64;
        let area = ((m.right - m.left) as i64) * ((m.bottom - m.top) as i64);
        if ow * oh * 2 < area {
            return 1; // under half the monitor: a floating window, not what we are looking for
        }
        s.decided.insert(id);
        let covers = r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom;
        let has_caption = GetWindowLongW(h, GWL_STYLE) & WS_CAPTION == WS_CAPTION;
        // A *maximised* window is not fullscreen even with no title bar: frameless apps (ChatGPT, Discord and
        // other Electron apps) draw their own title bar and, maximised on a monitor with an auto-hiding
        // taskbar, cover it exactly. Real fullscreen (games, video) is not "zoomed"; Chrome un-maximises first.
        if covers && !has_caption && IsZoomed(h) == 0 {
            s.occupied.push(id);
        }
    }
    1
}

/// Ids of the monitors that currently have a fullscreen app (a game, a video) in front.
fn fullscreen_monitors(monitors: &[Mon]) -> Vec<i64> {
    let mut scan = Scan { monitors, pid: std::process::id(), decided: HashSet::new(), occupied: Vec::new() };
    unsafe {
        EnumWindows(scan_window, &mut scan as *mut _ as isize);
    }
    scan.occupied.sort();
    scan.occupied
}

/// Append a line to `pet.log` in the app's data folder (rotated at 512 KB). The page reports settings
/// changes and any error here, so "it didn't change" can be diagnosed afterwards instead of guessed at.
#[tauri::command]
fn log_line(app: AppHandle, text: String) {
    use std::io::Write;
    let dir = data_dir(&app);
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("pet.log");
    if fs::metadata(&path).map(|m| m.len() > 512 * 1024).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join("pet.old.log"));
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{}", text.chars().take(2000).collect::<String>());
    }
}

/// Global cursor position in physical pixels. The webview can't see the mouse
/// once the window is click-through, so the page polls this instead.
#[tauri::command]
fn cursor_pos() -> [i32; 2] {
    let mut p = Point { x: 0, y: 0 };
    unsafe {
        GetCursorPos(&mut p);
    }
    [p.x, p.y]
}

// ------------------------------------------------------------------ displays

#[derive(Serialize, Clone, PartialEq, Default)]
struct Displays {
    monitors: Vec<Mon>,
    occupied: Vec<i64>,
}

fn read_displays() -> Displays {
    let monitors = list_monitors();
    let occupied = fullscreen_monitors(&monitors);
    Displays { monitors, occupied }
}

#[tauri::command]
fn display_state(state: State<AppState>) -> Displays {
    let d = read_displays();
    *state.displays.lock().unwrap() = d.clone();
    d
}

// ------------------------------------------------------------------ settings

#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    species: Option<u32>,
    /// which form of that species: empty is the base form, otherwise a key like `_f03` or `_f01_d2`
    #[serde(default)]
    form: String,
    shiny: bool,
    /// wander from monitor to monitor on his own
    #[serde(default = "yes")]
    roam: bool,
    /// when no monitor is free of a fullscreen app, keep walking over it (never clickable) instead of hiding
    #[serde(default)]
    overlay: bool,
}

fn yes() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings { species: None, form: String::new(), shiny: false, roam: true, overlay: false }
    }
}

struct TrayItems {
    shiny: CheckMenuItem<Wry>,
    roam: CheckMenuItem<Wry>,
    overlay: CheckMenuItem<Wry>,
}

struct AppState {
    settings: Mutex<Settings>,
    items: Mutex<Option<TrayItems>>,
    displays: Mutex<Displays>,
}

fn data_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn load_settings(app: &AppHandle) -> Settings {
    fs::read_to_string(data_dir(app).join("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &Settings) {
    let dir = data_dir(app);
    let _ = fs::create_dir_all(&dir);
    if let Ok(text) = serde_json::to_string_pretty(s) {
        let _ = fs::write(dir.join("settings.json"), text);
    }
}

/// Apply a settings change: persist it, tick the tray boxes, and tell every window.
fn commit(app: &AppHandle, state: &AppState, change: impl FnOnce(&mut Settings)) {
    let snapshot = {
        let mut s = state.settings.lock().unwrap();
        change(&mut s);
        s.clone()
    };
    save_settings(app, &snapshot);
    if let Some(items) = state.items.lock().unwrap().as_ref() {
        let _ = items.shiny.set_checked(snapshot.shiny);
        let _ = items.roam.set_checked(snapshot.roam);
        let _ = items.overlay.set_checked(snapshot.overlay);
    }
    let _ = app.emit("settings-changed", snapshot);
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn set_species(app: AppHandle, state: State<AppState>, species: u32, form: Option<String>) {
    let form = form.filter(|f| is_form_key(f)).unwrap_or_default();
    commit(&app, &state, |s| {
        s.species = Some(species);
        s.form = form;
    });
}

#[tauri::command]
fn set_shiny(app: AppHandle, state: State<AppState>, on: bool) {
    commit(&app, &state, |s| s.shiny = on);
}

#[tauri::command]
fn set_roam(app: AppHandle, state: State<AppState>, on: bool) {
    commit(&app, &state, |s| s.roam = on);
}

#[tauri::command]
fn set_overlay(app: AppHandle, state: State<AppState>, on: bool) {
    commit(&app, &state, |s| s.overlay = on);
}

// ------------------------------------------------------------------ model packs

/// Where model files are looked up, best first: the user's own folder (extra packs dropped in
/// or downloaded later), then what the installer bundled, then the project's `pack/` in dev builds.
fn model_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = vec![data_dir(app).join("models")];
    if let Ok(res) = app.path().resource_dir() {
        dirs.push(res.join("models"));
    }
    if cfg!(debug_assertions) {
        dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("pack"));
    }
    dirs
}

/// A form key is empty (the base form) or `_fNN` / `_fNN_dN`: digits only, so it can never name another path.
fn is_form_key(f: &str) -> bool {
    if f.is_empty() {
        return true;
    }
    let Some(rest) = f.strip_prefix("_f") else { return false };
    let (form, detail) = match rest.split_once("_d") {
        Some((a, b)) => (a, Some(b)),
        None => (rest, None),
    };
    form.len() == 2
        && form.bytes().all(|b| b.is_ascii_digit())
        && detail.map_or(true, |d| !d.is_empty() && d.len() <= 3 && d.bytes().all(|b| b.is_ascii_digit()))
}

fn file_name(species: u32, form: &str, shiny: bool) -> String {
    format!("{:04}{}{}.glb", species, form, if shiny { "_shiny" } else { "" })
}

fn find_model(app: &AppHandle, species: u32, form: &str, shiny: bool) -> Option<PathBuf> {
    model_dirs(app)
        .into_iter()
        .map(|d| d.join(file_name(species, form, shiny)))
        .find(|p| p.is_file())
}

#[derive(Serialize)]
struct ModelEntry {
    species: u32,
    form: String,
    shiny: bool,
    name: Option<String>,
}

/// Split `0201_f03` into (201, "_f03"). None if it is not a model stem.
fn parse_stem(stem: &str) -> Option<(u32, String)> {
    let num = stem.get(..4)?;
    let form = stem.get(4..)?;
    if !num.bytes().all(|b| b.is_ascii_digit()) || !is_form_key(form) {
        return None;
    }
    Some((num.parse().ok()?, form.to_string()))
}

fn read_index(app: &AppHandle) -> serde_json::Map<String, serde_json::Value> {
    fs::read_to_string(data_dir(app).join("models").join("index.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Every model installed (one entry per species and form), and whether a shiny variant exists.
#[tauri::command]
fn list_models(app: AppHandle) -> Vec<ModelEntry> {
    let mut found: std::collections::BTreeMap<(u32, String), bool> = Default::default();
    for dir in model_dirs(&app) {
        let Ok(entries) = fs::read_dir(dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let Some(stem) = name.strip_suffix(".glb") else { continue };
            let (base, shiny) = match stem.strip_suffix("_shiny") {
                Some(n) => (n, true),
                None => (stem, false),
            };
            if let Some(key) = parse_stem(base) {
                let slot = found.entry(key).or_insert(false);
                if shiny {
                    *slot = true;
                }
            }
        }
    }
    let index = read_index(&app);
    found
        .into_iter()
        .map(|((species, form), shiny)| {
            let name = index.get(&format!("{:04}{}", species, form)).and_then(|v| v.as_str()).map(String::from);
            ModelEntry { species, form, shiny, name }
        })
        .collect()
}

/// Raw bytes of a model. The path is built here from the species number and a validated form key, never taken
/// from the page. A missing shiny falls back to the normal model.
#[tauri::command]
fn read_model(app: AppHandle, species: u32, shiny: bool, form: Option<String>) -> Result<Response, String> {
    let form = form.unwrap_or_default();
    if !is_form_key(&form) {
        return Err("bad form".into());
    }
    let path = find_model(&app, species, &form, shiny)
        .or_else(|| find_model(&app, species, &form, false))
        .ok_or_else(|| format!("no model installed for species {species}{form}"))?;
    fs::read(&path).map(Response::new).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct ImportResult {
    added: usize,
    skipped: usize,
}

/// Only plain model files are ever extracted: `0025.glb`, `0201_f03.glb`, `0869_f01_d2_shiny.glb`. Everything else
/// in a zip is ignored (except `index.json`, the form names), so a pack cannot write outside the models folder.
fn is_model_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".glb") else { return false };
    let base = stem.strip_suffix("_shiny").unwrap_or(stem);
    parse_stem(base).is_some()
}

/// Ask for one or more pack zips and unpack their models into the user's models folder.
#[tauri::command]
async fn import_pack(app: AppHandle) -> Result<Option<ImportResult>, String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_title("Load a model pack")
        .add_filter("Model pack (.zip)", &["zip"])
        .pick_files()
        .await;
    let Some(files) = picked else { return Ok(None) };
    let dir = data_dir(&app).join("models");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (mut added, mut skipped) = (0usize, 0usize);
    let mut index = read_index(&app);
    for f in files {
        let file = fs::File::open(f.path()).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("{} is not a model pack: {e}", f.file_name()))?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
            let base = entry.name().rsplit(|c| c == '/' || c == '\\').next().unwrap_or("").to_string();
            if entry.is_dir() {
                continue;
            }
            if base == "index.json" {
                let mut text = String::new();
                std::io::Read::read_to_string(&mut entry, &mut text).map_err(|e| e.to_string())?;
                if let Ok(serde_json::Value::Object(map)) = serde_json::from_str(&text) {
                    for (k, v) in map {
                        if parse_stem(&k).is_some() && v.is_string() {
                            index.insert(k, v);
                        }
                    }
                }
                continue;
            }
            if !is_model_name(&base) {
                skipped += 1;
                continue;
            }
            let mut bytes = Vec::with_capacity(entry.size() as usize);
            std::io::Read::read_to_end(&mut entry, &mut bytes).map_err(|e| e.to_string())?;
            if bytes.len() < 12 || &bytes[..4] != b"glTF" {
                skipped += 1;
                continue;
            }
            let tmp = dir.join(format!("{base}.part"));
            fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
            fs::rename(&tmp, dir.join(&base)).map_err(|e| e.to_string())?;
            added += 1;
        }
    }
    let _ = fs::write(dir.join("index.json"), serde_json::to_string(&index).unwrap_or_default());
    Ok(Some(ImportResult { added, skipped }))
}

// ------------------------------------------------------------------ windows and tray

fn open_picker(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("picker") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "picker", WebviewUrl::App("picker.html".into()))
        .title("Choose your Pokémon")
        .inner_size(840.0, 680.0)
        .min_inner_size(520.0, 420.0)
        .center()
        .build();
}

#[tauri::command]
fn open_picker_cmd(app: AppHandle) {
    open_picker(&app);
}

fn build_menu(app: &AppHandle, s: &Settings, monitors: &[Mon]) -> tauri::Result<(Menu<Wry>, TrayItems)> {
    let picker = MenuItem::with_id(app, "picker", "Change Pokémon…", true, None::<&str>)?;
    let shiny = CheckMenuItem::with_id(app, "shiny", "Shiny", true, s.shiny, None::<&str>)?;
    let roam = CheckMenuItem::with_id(app, "roam", "Walk between monitors", true, s.roam, None::<&str>)?;
    let overlay = CheckMenuItem::with_id(
        app,
        "overlay",
        "Keep walking over fullscreen apps (not clickable)",
        true,
        s.overlay,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::new(app)?;
    menu.append(&picker)?;
    menu.append(&shiny)?;
    if monitors.len() > 1 {
        let sub = Submenu::with_id(app, "monitors", "Move to monitor", true)?;
        for (i, m) in monitors.iter().enumerate() {
            let label = format!(
                "{} · {}×{}{}",
                i + 1,
                m.right - m.left,
                m.bottom - m.top,
                if m.primary { " (main)" } else { "" }
            );
            sub.append(&MenuItem::with_id(app, format!("mon:{}", m.id), label, true, None::<&str>)?)?;
        }
        menu.append(&sub)?;
        menu.append(&roam)?;
    }
    menu.append(&overlay)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&quit)?;
    Ok((menu, TrayItems { shiny, roam, overlay }))
}

/// Rebuild the tray menu (the "Move to monitor" list follows the monitors that are plugged in).
fn refresh_menu(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().clone();
    let monitors = state.displays.lock().unwrap().monitors.clone();
    if let Ok((menu, items)) = build_menu(app, &settings, &monitors) {
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_menu(Some(menu));
        }
        *state.items.lock().unwrap() = Some(items);
    }
}

fn main() {
    tauri::Builder::default()
        // a second launch (Start menu, shortcut) opens the picker in the running copy
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| open_picker(app)))
        .invoke_handler(tauri::generate_handler![
            cursor_pos,
            log_line,
            display_state,
            get_settings,
            set_species,
            set_shiny,
            set_roam,
            set_overlay,
            list_models,
            read_model,
            import_pack,
            open_picker_cmd
        ])
        .on_window_event(|window, event| {
            // closing the picker before ever choosing a Pokémon means there is nothing to show
            if let WindowEvent::Destroyed = event {
                if window.label() == "picker" {
                    let app = window.app_handle();
                    let chosen = app.state::<AppState>().settings.lock().unwrap().species.is_some();
                    if !chosen {
                        app.exit(0);
                    }
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = load_settings(&handle);
            let displays = read_displays();
            let first_run = settings.species.is_none();

            let (menu, items) = build_menu(&handle, &settings, &displays.monitors)?;
            app.manage(AppState {
                settings: Mutex::new(settings),
                items: Mutex::new(Some(items)),
                displays: Mutex::new(displays),
            });

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Pokémon desktop pet")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        open_picker(tray.app_handle());
                    }
                })
                .on_menu_event(|app, e| {
                    let state = app.state::<AppState>();
                    let checked = |pick: fn(&TrayItems) -> &CheckMenuItem<Wry>| {
                        state.items.lock().unwrap().as_ref().and_then(|i| pick(i).is_checked().ok()).unwrap_or(false)
                    };
                    match e.id.as_ref() {
                        "picker" => open_picker(app),
                        "shiny" => {
                            let on = checked(|i| &i.shiny);
                            commit(app, &state, |s| s.shiny = on);
                        }
                        "roam" => {
                            let on = checked(|i| &i.roam);
                            commit(app, &state, |s| s.roam = on);
                        }
                        "overlay" => {
                            let on = checked(|i| &i.overlay);
                            commit(app, &state, |s| s.overlay = on);
                        }
                        "quit" => app.exit(0),
                        id if id.starts_with("mon:") => {
                            if let Ok(mon) = id[4..].parse::<i64>() {
                                let _ = app.emit("move-to-monitor", mon);
                            }
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            if first_run {
                open_picker(&handle);
            }

            // Watch the monitors and the fullscreen apps on them; only changes are sent. The page asks
            // for the current state at startup via `display_state`.
            let watcher = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(600));
                let now = read_displays();
                let state = watcher.state::<AppState>();
                let (changed, monitors_changed) = {
                    let mut last = state.displays.lock().unwrap();
                    let changed = *last != now;
                    let monitors_changed = last.monitors != now.monitors;
                    if changed {
                        *last = now.clone();
                    }
                    (changed, monitors_changed)
                };
                if changed {
                    let _ = watcher.emit("displays-changed", &now);
                    if monitors_changed {
                        let app = watcher.clone();
                        let _ = watcher.run_on_main_thread(move || refresh_menu(&app));
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the pet");
}
