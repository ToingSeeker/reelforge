//! The desktop shell owns no editing logic. It talks to the shared ReelForge engine (`reelforge serve`,
//! the same core the CLI and MCP server use), bound to 127.0.0.1, and hands the webview its URL and token.
//!
//! Two ways the engine runs:
//!   - inside the editor: a child process with a per-launch token, stopped when the app quits;
//!   - in the background (Remote Access on): a launchd agent (background.rs) that outlives the editor, so
//!     the phone remote, renders and agent jobs keep going with the window closed or the editor quit. The
//!     editor attaches to it through <home>/engine.json and never stops it on quit.

mod background;

use serde::Serialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::DialogExt;

/// Origins the engine accepts. The Vite dev server's origin only in development builds: in a release
/// any page served on that port (an unrelated project) would otherwise pass the Origin check.
const ALLOWED_ORIGINS: &[&str] = &["tauri://localhost", "http://tauri.localhost"];
const DEV_ORIGIN: &str = "http://localhost:5173";

fn allowed_origins(release: bool) -> Vec<&'static str> {
    let mut origins = ALLOWED_ORIGINS.to_vec();
    if !release {
        origins.push(DEV_ORIGIN);
    }
    origins
}
const READY_TIMEOUT: Duration = Duration::from_secs(160);

#[derive(Clone, Serialize)]
struct ApiInfo {
    url: String,
    token: String,
}

enum EngineState {
    Starting,
    Ready(ApiInfo),
    Failed(String),
}

/// The engine the editor talks to: either its own child (stops with the app), or the background engine
/// launchd runs for Remote Access (`attached`: the app never stops it on quit).
struct Engine {
    state: Arc<(Mutex<EngineState>, Condvar)>,
    child: Mutex<Option<Child>>,
    /// The child's stdin: closing it stops the child; JSON lines on it deliver API keys.
    stdin: Mutex<Option<ChildStdin>>,
    attached: AtomicBool,
    /// The main window is on screen (drives the editor heartbeat the phone sees as "Editor open").
    visible: AtomicBool,
}

impl Engine {
    fn info(&self) -> Option<ApiInfo> {
        match &*self.state.0.lock().ok()? {
            EngineState::Ready(i) => Some(i.clone()),
            _ => None,
        }
    }

    fn set(&self, s: EngineState) {
        let (lock, cvar) = &*self.state;
        if let Ok(mut g) = lock.lock() {
            *g = s;
        }
        cvar.notify_all();
    }

    /// Stops the child engine if we own one (closing stdin tells it to exit; kill if it lingers).
    fn stop_child(&self) {
        if let Ok(mut stdin) = self.stdin.lock() {
            stdin.take();
        }
        if let Some(mut child) = self.child.lock().ok().and_then(|mut c| c.take()) {
            let end = std::time::Instant::now() + Duration::from_secs(5);
            while std::time::Instant::now() < end {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// One request to whichever engine is current.
    fn call(&self, method: &str, path: &str, body: Option<&str>) -> Result<(u16, String), String> {
        let info = self.info().ok_or("the engine isn't running")?;
        // A background engine can die and its port be taken by another process: re-check before every
        // request that the listener is still the engine holding this token, so the token (and any key we
        // push) never goes to it.
        if self.attached.load(Ordering::SeqCst) && !background::proves(&info.url, &info.token) {
            return Err("the background engine is no longer at its address".into());
        }
        background::http(&info.url, method, path, Some(&info.token), body)
    }
}

/// AI provider keys live in the macOS Keychain (Security framework, never in argv or files).
const KEYCHAIN_SERVICE: &str = "io.reelforge.studio";
const PROVIDERS: &[&str] = &["anthropic"];

fn keychain(provider: &str) -> Result<keyring::Entry, String> {
    if !PROVIDERS.contains(&provider) {
        return Err(format!("unknown provider {provider}"));
    }
    keyring::Entry::new(KEYCHAIN_SERVICE, provider).map_err(|e| e.to_string())
}

/// Hand a key to the engine (memory only there). `None` clears it. A child gets it on stdin; the
/// background engine over its token-authed API (it has no stdin from us).
fn push_credential(engine: &Engine, provider: &str, key: Option<&str>) -> Result<(), String> {
    if engine.attached.load(Ordering::SeqCst) {
        let body = serde_json::json!({ "provider": provider, "apiKey": key }).to_string();
        let (status, text) = engine.call("POST", "/v1/engine/credentials", Some(&body))?;
        return if status == 200 { Ok(()) } else { Err(format!("engine answered HTTP {status}: {text}")) };
    }
    let line = serde_json::json!({ "type": "credential", "provider": provider, "apiKey": key }).to_string();
    let mut guard = engine.stdin.lock().map_err(|e| e.to_string())?;
    let stdin = guard.as_mut().ok_or("engine is not running")?;
    stdin.write_all(format!("{line}\n").as_bytes()).and_then(|_| stdin.flush()).map_err(|e| e.to_string())
}

fn push_saved_keys(engine: &Engine) {
    for provider in PROVIDERS {
        if let Ok(key) = keychain(provider).and_then(|e| e.get_password().map_err(|e| e.to_string())) {
            let _ = push_credential(engine, provider, Some(&key));
        }
    }
}

#[tauri::command]
fn save_api_key(engine: tauri::State<'_, Arc<Engine>>, provider: String, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 512 {
        return Err("that doesn't look like an API key".into());
    }
    keychain(&provider)?.set_password(key).map_err(|e| e.to_string())?;
    // Saved either way; an engine that isn't running gets it from the Keychain when it starts.
    push_credential(&engine, &provider, Some(key)).map_err(|e| format!("saved in the Keychain, but the running engine didn't get it ({e}); restart ReelForge to use it"))
}

#[tauri::command]
fn delete_api_key(engine: tauri::State<'_, Arc<Engine>>, provider: String) -> Result<(), String> {
    match keychain(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(e.to_string()),
    }
    push_credential(&engine, &provider, None).map_err(|e| format!("removed from the Keychain, but the running engine still has it ({e}); restart ReelForge"))
}

#[tauri::command]
fn has_api_key(provider: String) -> Result<bool, String> {
    match keychain(&provider)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn api_info(engine: tauri::State<'_, Arc<Engine>>) -> Result<ApiInfo, String> {
    let (lock, cvar) = &*engine.state;
    let guard = lock.lock().map_err(|e| e.to_string())?;
    let (guard, _) = cvar
        .wait_timeout_while(guard, READY_TIMEOUT, |s| matches!(s, EngineState::Starting))
        .map_err(|e| e.to_string())?;
    match &*guard {
        EngineState::Ready(info) => Ok(info.clone()),
        EngineState::Failed(msg) => Err(msg.clone()),
        EngineState::Starting => Err("ReelForge engine did not start in time".into()),
    }
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| format!("could not read /dev/urandom: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Where the engine comes from. A release build runs the bundled one in
/// ReelForge.app/Contents/Resources/engine (official Node runtime + one-file bundle, built by
/// scripts/release/build-engine.mjs). A debug build runs the monorepo CLI on the developer's Node.
/// REELFORGE_NODE / REELFORGE_CLI override either.
struct EngineCommand {
    node: String,
    cli: PathBuf,
    fonts: Option<PathBuf>,
    /// The bundled AI effects engine (fx.py + its own Python), release builds only.
    fx: Option<PathBuf>,
    /// The bundled motion-graphics renderer (Remotion + its headless Chrome), release builds only.
    motion: Option<PathBuf>,
}

fn bundled_engine_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.parent()?.join("Resources/engine");
    dir.join("reelforge.mjs").is_file().then_some(dir)
}

fn engine_command() -> Result<EngineCommand, String> {
    let release = !cfg!(debug_assertions);
    resolve_engine(
        release,
        if release { bundled_engine_dir() } else { None },
        std::env::var("REELFORGE_NODE").ok(),
        std::env::var("REELFORGE_CLI").ok(),
    )
}

/// The engine receives the API key, so a release build runs only its own bundled engine: the
/// REELFORGE_NODE / REELFORGE_CLI overrides (and `node` from PATH) are for development builds.
fn resolve_engine(release: bool, bundled: Option<PathBuf>, node_override: Option<String>, cli_override: Option<String>) -> Result<EngineCommand, String> {
    if release {
        let dir = bundled.ok_or("the bundled ReelForge engine is missing from the app (Contents/Resources/engine); reinstall ReelForge")?;
        return Ok(EngineCommand {
            node: dir.join("node").to_string_lossy().into_owned(),
            cli: dir.join("reelforge.mjs"),
            fonts: Some(dir.join("fonts")),
            fx: Some(dir.join("fx")),
            motion: Some(dir.join("motion")),
        });
    }
    Ok(EngineCommand {
        node: node_override.unwrap_or_else(|| "node".into()),
        cli: cli_override.map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/cli/bin/reelforge.js")),
        fonts: None,
        fx: None,
        motion: None,
    })
}

/// Environment variables that make Node load other code (NODE_OPTIONS=--require …, NODE_PATH, …).
/// A release build removes them before starting the engine; development builds keep them for debugging.
fn node_vars_to_remove(release: bool, names: impl Iterator<Item = String>) -> Vec<String> {
    if !release {
        return Vec::new();
    }
    // Also the AI effects Python override: a release runs only the Python it ships.
    names.filter(|n| n.starts_with("NODE_") || n == "REELFORGE_FX_PYTHON").collect()
}

/// Apps opened from Finder get launchd's PATH (/usr/bin:/bin:…), not the shell's, so FFmpeg and
/// whisper.cpp from Homebrew wouldn't be found. Add the usual Homebrew locations after what we have.
fn engine_path() -> String {
    let mut parts: Vec<String> = std::env::var("PATH").unwrap_or_default().split(':').filter(|p| !p.is_empty()).map(String::from).collect();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        if !parts.iter().any(|p| p == extra) {
            parts.push(extra.into());
        }
    }
    parts.join(":")
}

/// Environment the engine runs with (child or launchd agent alike): PATH with Homebrew, and the bundled
/// fonts / AI effects / motion renderer of a release.
fn engine_env(fonts: &Option<PathBuf>, fx: &Option<PathBuf>, motion: &Option<PathBuf>) -> Vec<(String, String)> {
    let mut env = vec![("PATH".to_string(), engine_path())];
    if let Some(fonts) = fonts {
        // The bundle can't find assets relative to its own source tree.
        env.push(("REELFORGE_FONTS".into(), format!("{}/", fonts.display())));
    }
    if let Some(fx) = fx {
        env.push(("REELFORGE_FX_DIR".into(), fx.display().to_string()));
    }
    if let Some(motion) = motion {
        // Overwrites any inherited value: a release runs only the renderer it ships.
        env.push(("REELFORGE_MOTION_DIR".into(), motion.display().to_string()));
    }
    env
}

/// launchd runs ProgramArguments[0] as given, without searching PATH: a development build's bare `node`
/// is looked up here.
fn absolute_program(name: &str) -> String {
    if name.contains('/') {
        return name.to_string();
    }
    engine_path().split(':').map(|d| PathBuf::from(d).join(name)).find(|p| p.is_file()).map(|p| p.display().to_string()).unwrap_or_else(|| name.to_string())
}

/// The launchd agent for `serve --background`.
fn agent_spec() -> Result<background::AgentSpec, String> {
    let EngineCommand { node, cli, fonts, fx, motion } = engine_command()?;
    let cli = cli.canonicalize().unwrap_or(cli);
    let mut program = vec![absolute_program(&node), cli.display().to_string(), "serve".into(), "--background".into()];
    for origin in allowed_origins(!cfg!(debug_assertions)) {
        program.push("--allow-origin".into());
        program.push(origin.into());
    }
    let mut env = engine_env(&fonts, &fx, &motion);
    if let Some(home) = std::env::var_os("REELFORGE_HOME").filter(|h| !h.is_empty()) {
        env.push(("REELFORGE_HOME".into(), home.to_string_lossy().into_owned()));
    }
    // Development only (a release ignores these): keep pointing at the same CLI and Node.
    if cfg!(debug_assertions) {
        for name in ["REELFORGE_FX_PYTHON", "REELFORGE_MOTION_DIR"] {
            if let Ok(v) = std::env::var(name) {
                if !env.iter().any(|(k, _)| k == name) {
                    env.push((name.into(), v));
                }
            }
        }
    }
    Ok(background::AgentSpec { program, env, log: background::log_path() })
}

fn start_engine(state: Arc<(Mutex<EngineState>, Condvar)>) -> Result<(Child, Option<ChildStdin>), String> {
    let token = random_token()?;
    let EngineCommand { node, cli, fonts, fx, motion } = engine_command()?;
    let mut cmd = Command::new(&node);
    // The token goes over stdin, not the environment, which FFmpeg/whisper children would inherit.
    cmd.arg(&cli).arg("serve").arg("--token-stdin").env_remove("REELFORGE_API_TOKEN");
    for name in node_vars_to_remove(!cfg!(debug_assertions), std::env::vars_os().filter_map(|(k, _)| k.into_string().ok())) {
        cmd.env_remove(name);
    }
    for (k, v) in engine_env(&fonts, &fx, &motion) {
        cmd.env(k, v);
    }
    for origin in allowed_origins(!cfg!(debug_assertions)) {
        cmd.arg("--allow-origin").arg(origin);
    }
    let mut child = cmd
        // Keep stdin open: the engine exits when it closes, so it never outlives us.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("could not start the ReelForge engine with `{node} {}`: {e}", cli.display()))?;

    let stdout = child.stdout.take().ok_or("engine stdout unavailable")?;
    let mut stdin = child.stdin.take();
    if let Some(pipe) = stdin.as_mut() {
        let line = serde_json::json!({ "type": "token", "token": token }).to_string();
        pipe.write_all(format!("{line}\n").as_bytes()).and_then(|_| pipe.flush()).map_err(|e| format!("could not hand the engine its token: {e}"))?;
    }
    std::thread::spawn(move || {
        let mut line = String::new();
        let outcome = match BufReader::new(stdout).read_line(&mut line) {
            Ok(0) => EngineState::Failed("ReelForge engine exited before it was ready (see terminal output)".into()),
            Ok(_) => match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(v) if v["event"] == "ready" => match v["url"].as_str() {
                    Some(url) => EngineState::Ready(ApiInfo { url: url.to_string(), token }),
                    None => EngineState::Failed("engine ready line had no url".into()),
                },
                _ => EngineState::Failed(format!("unexpected engine output: {}", line.trim())),
            },
            Err(e) => EngineState::Failed(format!("reading engine output failed: {e}")),
        };
        let (lock, cvar) = &*state;
        if let Ok(mut s) = lock.lock() {
            *s = outcome;
        }
        cvar.notify_all();
    });
    Ok((child, stdin))
}

/// Starts the engine as our child (Remote Access off). Keys go to it on stdin.
fn spawn_child(engine: &Engine) {
    engine.attached.store(false, Ordering::SeqCst);
    engine.set(EngineState::Starting);
    match start_engine(engine.state.clone()) {
        Ok((child, stdin)) => {
            *engine.child.lock().expect("engine poisoned") = Some(child);
            *engine.stdin.lock().expect("engine poisoned") = stdin;
            // Keys saved earlier go to the engine at startup (stdin is buffered until it reads it).
            push_saved_keys(engine);
        }
        Err(msg) => {
            eprintln!("[reelforge] {msg}");
            engine.set(EngineState::Failed(msg));
        }
    }
}

fn attach(engine: &Engine, f: background::EngineFile) {
    engine.attached.store(true, Ordering::SeqCst);
    engine.set(EngineState::Ready(ApiInfo { url: f.url, token: f.token }));
    push_saved_keys(engine);
    send_editor_state(engine);
}

/// How long a starting background engine is waited for. Generous: on a busy Mac it can take a minute
/// (measured ~67 s under heavy load), and giving up early would start a second engine on the same database.
const BACKGROUND_START_TIMEOUT: Duration = Duration::from_secs(150);

enum StartError {
    /// launchd refused the job: nothing is running, so the editor may run its own engine.
    NotStarted(String),
    /// launchd took the job but the engine isn't answering yet: it may still come up, so no second engine.
    Slow(String),
}

/// Starts (or restarts) the launchd agent and attaches to it.
fn start_background(engine: &Engine, plist: &std::path::Path) -> Result<(), StartError> {
    engine.set(EngineState::Starting);
    background::bootstrap(plist).map_err(StartError::NotStarted)?;
    let _ = background::kickstart();
    let f = background::wait_for_engine(BACKGROUND_START_TIMEOUT)
        .ok_or_else(|| StartError::Slow(format!("ReelForge Engine is still starting in the background; see {}", background::log_path().display())))?;
    attach(engine, f);
    Ok(())
}

/// What the editor uses at launch: a background engine already running, else the agent if Remote Access
/// is on, else its own child.
fn choose_engine(engine: &Engine) {
    if let Some(f) = background::running_engine() {
        return attach(engine, f);
    }
    if let Some(plist) = background::installed_plist() {
        match start_background(engine, &plist) {
            Ok(()) => return,
            Err(StartError::NotStarted(e)) => eprintln!("[reelforge] {e}; running the engine inside the editor instead"),
            Err(StartError::Slow(e)) => {
                eprintln!("[reelforge] {e}");
                return engine.set(EngineState::Failed(e));
            }
        }
    }
    spawn_child(engine);
}

/// "Open" while the window is on screen, "closed" when it isn't: what the phone shows as the editor's state.
fn send_editor_state(engine: &Engine) {
    let state = if engine.visible.load(Ordering::SeqCst) { "open" } else { "closed" };
    let _ = engine.call("POST", "/v1/engine/editor", Some(&format!("{{\"state\":\"{state}\"}}")));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundStatus {
    /// Remote Access's background engine is set up (its launchd agent is installed).
    installed: bool,
    start_at_login: bool,
    /// A background engine answers right now.
    running: bool,
    /// The editor is using it (rather than its own child engine).
    attached: bool,
    pid: Option<u32>,
    log_path: String,
}

#[tauri::command]
fn background_engine_status(engine: tauri::State<'_, Arc<Engine>>) -> BackgroundStatus {
    let running = background::running_engine();
    BackgroundStatus {
        installed: background::installed_plist().is_some(),
        start_at_login: background::login_plist_path().is_file(),
        running: running.is_some(),
        attached: engine.attached.load(Ordering::SeqCst),
        pid: running.map(|f| f.pid),
        log_path: background::log_path().display().to_string(),
    }
}

/// Turns the background engine on (install the agent, hand over from our child) or off (remove the
/// agent, run our own child again). The webview reloads afterwards and asks api_info again.
#[tauri::command]
async fn set_remote_access(app: AppHandle, enabled: bool, start_at_login: bool) -> Result<(), String> {
    let engine = app.state::<Arc<Engine>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if enabled {
            let plist = background::write_plist(&agent_spec()?, start_at_login)?;
            if engine.attached.load(Ordering::SeqCst) && background::running_engine().is_some() {
                return Ok(()); // already running in the background; the plist now says where it loads from
            }
            // One engine per database: ours stops before launchd's starts.
            engine.stop_child();
            if let Err(e) = start_background(&engine, &plist) {
                // Taken back out of launchd (which stops it if it did start), and only then our own engine.
                background::bootout();
                background::remove_plists();
                let end = std::time::Instant::now() + Duration::from_secs(10);
                while background::running_engine().is_some() && std::time::Instant::now() < end {
                    std::thread::sleep(Duration::from_millis(200));
                }
                spawn_child(&engine);
                return Err(match e {
                    StartError::NotStarted(m) | StartError::Slow(m) => m,
                });
            }
            Ok(())
        } else {
            background::bootout();
            background::remove_plists();
            // bootout sends SIGTERM; give the engine a moment to close the database before ours opens it.
            let end = std::time::Instant::now() + Duration::from_secs(10);
            while background::running_engine().is_some() && std::time::Instant::now() < end {
                std::thread::sleep(Duration::from_millis(200));
            }
            if engine.child.lock().map(|c| c.is_none()).unwrap_or(true) {
                spawn_child(&engine);
            }
            Ok(())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn set_start_at_login(enabled: bool) -> Result<(), String> {
    background::move_plist(enabled)
}

/// Stop Engine & Disconnect: the background engine turns the phone remote off and exits (launchd won't
/// restart a clean exit). The open editor goes on with its own engine, without remote access.
fn stop_background(app: &AppHandle) -> Result<(), String> {
    let engine = app.state::<Arc<Engine>>().inner().clone();
    if !engine.attached.load(Ordering::SeqCst) {
        return Err("the engine isn't running in the background".into());
    }
    let (status, text) = engine.call("POST", "/v1/engine/stop", None)?;
    if status != 202 {
        return Err(format!("the engine answered HTTP {status}: {text}"));
    }
    let end = std::time::Instant::now() + Duration::from_secs(15);
    while background::running_engine().is_some() && std::time::Instant::now() < end {
        std::thread::sleep(Duration::from_millis(200));
    }
    background::bootout();
    spawn_child(&engine);
    let _ = app.emit("engine-changed", ());
    Ok(())
}

#[tauri::command]
async fn stop_engine_and_disconnect(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_background(&app)).await.map_err(|e| e.to_string())?
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    let engine = app.state::<Arc<Engine>>().inner().clone();
    if !engine.visible.swap(true, Ordering::SeqCst) {
        std::thread::spawn(move || send_editor_state(&engine));
    }
}

/// The menu bar item: status, open the editor or its Remote Access settings, stop the background engine.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "Engine: starting…", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Editor", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Remote Access Settings…", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop Engine & Disconnect", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit ReelForge Editor", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&status, &sep, &open, &settings, &sep2, &stop, &quit])?;
    let mut tray = TrayIconBuilder::with_id("reelforge").menu(&menu).show_menu_on_left_click(true).tooltip("ReelForge");
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, event| match event.id().as_ref() {
        "open" => show_main(app),
        "settings" => {
            show_main(app);
            let _ = app.emit("open-remote-access", ());
        }
        "stop" => {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(e) = stop_background(&app) {
                    app.dialog().message(format!("Couldn't stop the engine: {e}")).title("ReelForge").show(|_| {});
                }
            });
        }
        "quit" => app.exit(0),
        _ => {}
    })
    .build(app)?;

    // The status line, kept current (the engine may be stopped from Settings, or the relay drop).
    let app = app.clone();
    std::thread::spawn(move || loop {
        let engine = app.state::<Arc<Engine>>().inner().clone();
        let attached = engine.attached.load(Ordering::SeqCst);
        let remote = engine
            .call("GET", "/v1/remote", None)
            .ok()
            .filter(|(s, _)| *s == 200)
            .and_then(|(_, body)| serde_json::from_str::<serde_json::Value>(&body).ok())
            .and_then(|v| v["remote"]["state"].as_str().map(String::from));
        let remote = match remote.as_deref() {
            Some("online") => "Remote online",
            Some("connecting") => "Remote reconnecting",
            Some("error") => "Remote refused by the relay",
            Some(_) => "Remote off",
            None => "Remote unknown",
        };
        let text = match (engine.info().is_some(), attached) {
            (false, _) => "Engine: not running".to_string(),
            (true, true) => format!("Engine: in the background · {remote}"),
            (true, false) => format!("Engine: inside the editor · {remote}"),
        };
        let _ = status.set_text(text);
        let _ = stop.set_enabled(attached);
        std::thread::sleep(Duration::from_secs(4));
    });
    Ok(())
}

const QUIT_NOTICE: &str = ".quit-notice-shown";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let engine = Arc::new(Engine {
        state: Arc::new((Mutex::new(EngineState::Starting), Condvar::new())),
        child: Mutex::new(None),
        stdin: Mutex::new(None),
        attached: AtomicBool::new(false),
        visible: AtomicBool::new(true),
    });
    // Attaching may wait for launchd to start the engine; the window opens meanwhile (api_info waits).
    {
        let engine = engine.clone();
        std::thread::spawn(move || choose_engine(&engine));
    }
    // The editor's heartbeat: the phone shows "Editor open" only while the window is on screen.
    {
        let engine = engine.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(15));
            if engine.visible.load(Ordering::SeqCst) {
                send_editor_state(&engine);
            }
        });
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(engine)
        .invoke_handler(tauri::generate_handler![
            api_info,
            save_api_key,
            delete_api_key,
            has_api_key,
            background_engine_status,
            set_remote_access,
            set_start_at_login,
            stop_engine_and_disconnect
        ])
        .setup(|app| {
            if let Err(e) = build_tray(app.handle()) {
                eprintln!("[reelforge] no menu bar item: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            let engine = window.app_handle().state::<Arc<Engine>>().inner().clone();
            if let WindowEvent::CloseRequested { api, .. } = event {
                // With the engine in the background, closing the window only hides the editor: jobs and
                // the phone remote go on, and the menu bar item brings it back.
                if engine.attached.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                    engine.visible.store(false, Ordering::SeqCst);
                    std::thread::spawn(move || send_editor_state(&engine));
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the ReelForge desktop app")
        .run(|app, event| match event {
            RunEvent::Reopen { .. } => show_main(app),
            RunEvent::ExitRequested { api, code, .. } => {
                // Once: say why the engine stays on after the editor quits.
                let engine = app.state::<Arc<Engine>>().inner().clone();
                let flag = background::reelforge_home().join(QUIT_NOTICE);
                if code.is_none() && engine.attached.load(Ordering::SeqCst) && !flag.exists() {
                    api.prevent_exit();
                    let _ = std::fs::create_dir_all(background::reelforge_home());
                    let _ = std::fs::write(&flag, "");
                    let app = app.clone();
                    app.dialog()
                        .message("ReelForge Engine continues running for remote access. Stop it from the menu bar item or Settings → Remote Access.")
                        .title("ReelForge")
                        .show(move |_| app.exit(0));
                }
            }
            RunEvent::Exit => {
                let engine = app.state::<Arc<Engine>>().inner().clone();
                engine.visible.store(false, Ordering::SeqCst);
                if engine.attached.load(Ordering::SeqCst) {
                    // The background engine stays; it only learns the editor is gone.
                    send_editor_state(&engine);
                } else {
                    engine.stop_child();
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle() -> Option<PathBuf> {
        Some(PathBuf::from("/Applications/ReelForge.app/Contents/Resources/engine"))
    }

    #[test]
    fn release_ignores_engine_overrides() {
        let e = resolve_engine(true, bundle(), Some("/tmp/evil-node".into()), Some("/tmp/evil.mjs".into())).unwrap();
        assert_eq!(e.node, "/Applications/ReelForge.app/Contents/Resources/engine/node");
        assert_eq!(e.cli, PathBuf::from("/Applications/ReelForge.app/Contents/Resources/engine/reelforge.mjs"));
        assert_eq!(e.fx, Some(PathBuf::from("/Applications/ReelForge.app/Contents/Resources/engine/fx")));
        assert_eq!(e.motion, Some(PathBuf::from("/Applications/ReelForge.app/Contents/Resources/engine/motion")));
    }

    #[test]
    fn release_without_bundle_refuses_instead_of_using_path_node() {
        assert!(resolve_engine(true, None, None, None).is_err());
        assert!(resolve_engine(true, None, Some("/tmp/evil-node".into()), None).is_err());
    }

    #[test]
    fn debug_honours_overrides() {
        let e = resolve_engine(false, None, Some("/opt/node".into()), Some("/src/cli.js".into())).unwrap();
        assert_eq!(e.node, "/opt/node");
        assert_eq!(e.cli, PathBuf::from("/src/cli.js"));
        assert_eq!(resolve_engine(false, None, None, None).unwrap().node, "node");
    }

    #[test]
    fn dev_origin_only_in_debug() {
        assert!(!allowed_origins(true).contains(&DEV_ORIGIN));
        assert!(allowed_origins(true).contains(&"tauri://localhost"));
        assert!(allowed_origins(false).contains(&DEV_ORIGIN));
    }

    #[test]
    fn release_strips_node_environment() {
        let names = ["NODE_OPTIONS", "NODE_PATH", "PATH", "HOME", "NODE_EXTRA_CA_CERTS", "REELFORGE_FX_PYTHON", "REELFORGE_FX_DIR"].map(String::from);
        let mut removed = node_vars_to_remove(true, names.clone().into_iter());
        removed.sort();
        // REELFORGE_FX_DIR is not removed: the shell overwrites it with the bundled engine.
        assert_eq!(removed, ["NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "NODE_PATH", "REELFORGE_FX_PYTHON"]);
        assert!(node_vars_to_remove(false, names.into_iter()).is_empty());
    }
}
