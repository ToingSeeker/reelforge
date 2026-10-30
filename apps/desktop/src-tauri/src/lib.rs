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

const ALLOWED_ORIGINS: &[&str] = &["http://localhost:5173", "tauri://localhost", "http://tauri.localhost"];
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
    push_credential(&engine, &provider, Some(key))
}

#[tauri::command]
fn delete_api_key(engine: tauri::State<'_, Engine>, provider: String) -> Result<(), String> {
    match keychain(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(e.to_string()),
    }
    push_credential(&engine, &provider, None)
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

/// Dev layout: the CLI lives in the monorepo. Packaging a bundled Node runtime
/// and engine is milestone M6; until then both can be overridden by env.
fn engine_command() -> (String, PathBuf) {
    let node = std::env::var("REELFORGE_NODE").unwrap_or_else(|_| "node".into());
    let cli = std::env::var("REELFORGE_CLI").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/cli/bin/reelforge.js")
    });
    (node, cli)
}

fn start_engine(state: Arc<(Mutex<EngineState>, Condvar)>) -> Result<(Child, Option<ChildStdin>), String> {
    let token = random_token()?;
    let (node, cli) = engine_command();
    let mut cmd = Command::new(&node);
    cmd.arg(&cli).arg("serve");
    for origin in ALLOWED_ORIGINS {
        cmd.arg("--allow-origin").arg(origin);
    }
    let mut child = cmd
        .env("REELFORGE_API_TOKEN", &token)
        // Keep stdin open: the engine exits when it closes, so it never outlives us.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("could not start the ReelForge engine with `{node} {}`: {e}", cli.display()))?;

    let stdout = child.stdout.take().ok_or("engine stdout unavailable")?;
    let stdin = child.stdin.take();
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
