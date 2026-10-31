//! The desktop shell owns no editing logic. It starts the shared ReelForge
//! engine (`reelforge serve`, the same core the CLI and MCP server use) as a
//! child process bound to 127.0.0.1, hands the webview its URL and a per-launch
//! token, and stops it on exit.

use serde::Serialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::{Manager, RunEvent};

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
const READY_TIMEOUT: Duration = Duration::from_secs(20);

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

struct Engine {
    state: Arc<(Mutex<EngineState>, Condvar)>,
    child: Mutex<Option<Child>>,
    /// The engine's stdin: closing it stops the engine; JSON lines on it deliver API keys.
    stdin: Mutex<Option<ChildStdin>>,
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

/// Hand a key to the engine (memory only there). `None` clears it.
fn push_credential(engine: &Engine, provider: &str, key: Option<&str>) -> Result<(), String> {
    let line = serde_json::json!({ "type": "credential", "provider": provider, "apiKey": key }).to_string();
    let mut guard = engine.stdin.lock().map_err(|e| e.to_string())?;
    let stdin = guard.as_mut().ok_or("engine is not running")?;
    stdin.write_all(format!("{line}\n").as_bytes()).and_then(|_| stdin.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_api_key(engine: tauri::State<'_, Engine>, provider: String, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 512 {
        return Err("that doesn't look like an API key".into());
    }
    keychain(&provider)?.set_password(key).map_err(|e| e.to_string())?;
    // Saved either way; an engine that isn't running gets it from the Keychain when it starts.
    push_credential(&engine, &provider, Some(key)).map_err(|e| format!("saved in the Keychain, but the running engine didn't get it ({e}); restart ReelForge to use it"))
}

#[tauri::command]
fn delete_api_key(engine: tauri::State<'_, Engine>, provider: String) -> Result<(), String> {
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
fn api_info(engine: tauri::State<'_, Engine>) -> Result<ApiInfo, String> {
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
        });
    }
    Ok(EngineCommand {
        node: node_override.unwrap_or_else(|| "node".into()),
        cli: cli_override.map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/cli/bin/reelforge.js")),
        fonts: None,
        fx: None,
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

fn start_engine(state: Arc<(Mutex<EngineState>, Condvar)>) -> Result<(Child, Option<ChildStdin>), String> {
    let token = random_token()?;
    let EngineCommand { node, cli, fonts, fx } = engine_command()?;
    let mut cmd = Command::new(&node);
    // The token goes over stdin, not the environment, which FFmpeg/whisper children would inherit.
    cmd.arg(&cli).arg("serve").arg("--token-stdin").env("PATH", engine_path()).env_remove("REELFORGE_API_TOKEN");
    for name in node_vars_to_remove(!cfg!(debug_assertions), std::env::vars_os().filter_map(|(k, _)| k.into_string().ok())) {
        cmd.env_remove(name);
    }
    if let Some(fonts) = fonts {
        // The bundle can't find assets relative to its own source tree.
        cmd.env("REELFORGE_FONTS", format!("{}/", fonts.display()));
    }
    if let Some(fx) = fx {
        cmd.env("REELFORGE_FX_DIR", fx);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new((Mutex::new(EngineState::Starting), Condvar::new()));
    let (child, stdin) = match start_engine(state.clone()) {
        Ok((c, i)) => (Some(c), i),
        Err(msg) => {
            eprintln!("[reelforge] {msg}");
            *state.0.lock().expect("engine state poisoned") = EngineState::Failed(msg);
            (None, None)
        }
    };
    let engine = Engine { state, child: Mutex::new(child), stdin: Mutex::new(stdin) };
    // Keys saved earlier go to the engine at startup (stdin is buffered until it reads it).
    for provider in PROVIDERS {
        if let Ok(key) = keychain(provider).and_then(|e| e.get_password().map_err(|e| e.to_string())) {
            let _ = push_credential(&engine, provider, Some(&key));
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(engine)
        .invoke_handler(tauri::generate_handler![api_info, save_api_key, delete_api_key, has_api_key])
        .build(tauri::generate_context!())
        .expect("error while building the ReelForge desktop app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Ok(mut stdin) = app.state::<Engine>().stdin.lock() {
                    stdin.take(); // closing stdin also tells the engine to exit
                }
                if let Some(mut child) = app.state::<Engine>().child.lock().ok().and_then(|mut c| c.take()) {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
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
