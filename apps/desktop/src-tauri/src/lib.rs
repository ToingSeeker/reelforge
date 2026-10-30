//! The desktop shell owns no editing logic. It starts the shared ReelForge
//! engine (`reelforge serve`, the same core the CLI and MCP server use) as a
//! child process bound to 127.0.0.1, hands the webview its URL and a per-launch
//! token, and stops it on exit.

use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
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

fn start_engine(state: Arc<(Mutex<EngineState>, Condvar)>) -> Result<Child, String> {
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
    Ok(child)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new((Mutex::new(EngineState::Starting), Condvar::new()));
    let child = match start_engine(state.clone()) {
        Ok(c) => Some(c),
        Err(msg) => {
            eprintln!("[reelforge] {msg}");
            *state.0.lock().expect("engine state poisoned") = EngineState::Failed(msg);
            None
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Engine { state, child: Mutex::new(child) })
        .invoke_handler(tauri::generate_handler![api_info])
        .build(tauri::generate_context!())
        .expect("error while building the ReelForge desktop app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Engine>().child.lock().ok().and_then(|mut c| c.take()) {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
