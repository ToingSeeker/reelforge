//! The background engine: `reelforge serve --background` run by launchd as a user LaunchAgent, so the
//! phone remote (and any render or agent job) keeps working when the editor window is closed or the
//! editor quits. The editor attaches to it through `<home>/engine.json`.
//!
//! Where the agent's plist lives decides "Start Engine at Login":
//!   - on:  ~/Library/LaunchAgents/io.reelforge.engine.plist — launchd loads it at every login;
//!   - off: <home>/launchd/io.reelforge.engine.plist — loaded only when the editor starts it.
//! Either way the job has KeepAlive {SuccessfulExit: false}: launchd restarts it after a crash, but not
//! after a clean exit (Stop Engine & Disconnect exits 0). That key implies RunAtLoad, which is why the
//! plist's *location*, not RunAtLoad, is what turns login start on and off.

use serde::Deserialize;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

pub const LABEL: &str = "io.reelforge.engine";

/// $REELFORGE_HOME, else the app-data folder the engine uses (packages/core/src/paths.ts).
pub fn reelforge_home() -> PathBuf {
    if let Some(h) = std::env::var_os("REELFORGE_HOME").filter(|h| !h.is_empty()) {
        return PathBuf::from(h);
    }
    user_home().join("Library/Application Support/ReelForge")
}

fn user_home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

pub fn login_plist_path() -> PathBuf {
    user_home().join("Library/LaunchAgents").join(format!("{LABEL}.plist"))
}

pub fn local_plist_path() -> PathBuf {
    reelforge_home().join("launchd").join(format!("{LABEL}.plist"))
}

pub fn log_path() -> PathBuf {
    user_home().join("Library/Logs/ReelForge/engine.log")
}

/// The installed plist (login location first), if Remote Access is on.
pub fn installed_plist() -> Option<PathBuf> {
    [login_plist_path(), local_plist_path()].into_iter().find(|p| p.is_file())
}

/// What `serve --background` writes for us.
#[derive(Debug, Clone, Deserialize)]
pub struct EngineFile {
    pub pid: u32,
    pub url: String,
    pub token: String,
    #[serde(default)]
    pub background: bool,
}

pub fn parse_engine_file(text: &str) -> Option<EngineFile> {
    let f: EngineFile = serde_json::from_str(text).ok()?;
    (f.background && f.token.len() >= 32 && port_of(&f.url).is_some()).then_some(f)
}

/// The background engine named by engine.json, if it really is ours: it must first prove it holds the
/// file's token (`proves`), and only then is the token sent. engine.json outlives a crashed engine, and its
/// port is free for any local process to take; that process must get neither the token nor a Keychain key.
pub fn running_engine() -> Option<EngineFile> {
    let text = std::fs::read_to_string(reelforge_home().join("engine.json")).ok()?;
    probe(parse_engine_file(&text)?)
}

fn probe(f: EngineFile) -> Option<EngineFile> {
    if !proves(&f.url, &f.token) {
        return None;
    }
    let (status, _) = http(&f.url, "GET", "/v1/engine", Some(&f.token), None).ok()?;
    (status == 200).then_some(f)
}

/// Asks whatever listens at `url` for HMAC-SHA256(token, "reelforge-engine-proof:" + nonce) over a fresh
/// random nonce, sending no secret. Only the engine that holds `token` can answer it.
pub fn proves(url: &str, token: &str) -> bool {
    let Some(nonce) = random_hex(16) else { return false };
    let Ok((200, body)) = http(url, "GET", &format!("/v1/engine/proof?nonce={nonce}"), None, None) else { return false };
    let Some(given) = serde_json::from_str::<serde_json::Value>(&body).ok().and_then(|v| v.get("proof")?.as_str().map(str::to_owned)) else { return false };
    let want = engine_proof(token, &nonce);
    // Same length, every byte compared: no early exit on the first difference.
    given.len() == want.len() && given.bytes().zip(want.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// The proof the engine computes (packages/server engineProof), as lowercase hex.
pub fn engine_proof(token: &str, nonce: &str) -> String {
    hex(&hmac_sha256(token.as_bytes(), format!("reelforge-engine-proof:{nonce}").as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn random_hex(n: usize) -> Option<String> {
    let mut buf = vec![0u8; n];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).ok()?;
    Some(hex(&buf))
}

// HMAC from CommonCrypto, part of macOS's libSystem: no crypto crate needed.
const K_CC_HMAC_ALG_SHA256: u32 = 2;
extern "C" {
    fn CCHmac(algorithm: u32, key: *const u8, key_length: usize, data: *const u8, data_length: usize, mac_out: *mut u8);
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    // SAFETY: pointers and lengths come from live slices; CCHmac writes exactly 32 bytes for SHA-256.
    unsafe { CCHmac(K_CC_HMAC_ALG_SHA256, key.as_ptr(), key.len(), data.as_ptr(), data.len(), out.as_mut_ptr()) };
    out
}

pub fn wait_for_engine(timeout: Duration) -> Option<EngineFile> {
    let end = Instant::now() + timeout;
    while Instant::now() < end {
        if let Some(f) = running_engine() {
            return Some(f);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    None
}

// ── plist ─────────────────────────────────────────────────────────────────

pub struct AgentSpec {
    pub program: Vec<String>,
    pub env: Vec<(String, String)>,
    pub log: PathBuf,
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

pub fn render_plist(spec: &AgentSpec) -> String {
    let mut out = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n",
    );
    out += &format!("  <key>Label</key>\n  <string>{}</string>\n", xml_escape(LABEL));
    out += "  <key>ProgramArguments</key>\n  <array>\n";
    for arg in &spec.program {
        out += &format!("    <string>{}</string>\n", xml_escape(arg));
    }
    out += "  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n";
    for (k, v) in &spec.env {
        out += &format!("    <key>{}</key>\n    <string>{}</string>\n", xml_escape(k), xml_escape(v));
    }
    out += "  </dict>\n";
    out += "  <key>RunAtLoad</key>\n  <true/>\n";
    out += "  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n";
    // Standard, not Background: "Background" puts the engine under background CPU/IO limits, and renders
    // and the AI Director then crawl (seen: minutes to start on a busy Mac).
    out += "  <key>ProcessType</key>\n  <string>Standard</string>\n";
    out += "  <key>ThrottleInterval</key>\n  <integer>10</integer>\n";
    let log = xml_escape(&spec.log.to_string_lossy());
    out += &format!("  <key>StandardOutPath</key>\n  <string>{log}</string>\n  <key>StandardErrorPath</key>\n  <string>{log}</string>\n");
    out += "</dict>\n</plist>\n";
    out
}

/// Writes the plist where `start_at_login` says, removing it from the other place.
pub fn write_plist(spec: &AgentSpec, start_at_login: bool) -> Result<PathBuf, String> {
    let (target, other) = if start_at_login { (login_plist_path(), local_plist_path()) } else { (local_plist_path(), login_plist_path()) };
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    }
    if let Some(dir) = spec.log.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&target, render_plist(spec)).map_err(|e| format!("couldn't write {}: {e}", target.display()))?;
    let _ = std::fs::remove_file(other);
    Ok(target)
}

/// Moves an installed plist to the other location (no restart: launchd tracks the loaded job by label).
pub fn move_plist(start_at_login: bool) -> Result<(), String> {
    let from = installed_plist().ok_or("Remote Access isn't enabled")?;
    let to = if start_at_login { login_plist_path() } else { local_plist_path() };
    if from == to {
        return Ok(());
    }
    if let Some(dir) = to.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
    std::fs::remove_file(&from).map_err(|e| e.to_string())
}

pub fn remove_plists() {
    let _ = std::fs::remove_file(login_plist_path());
    let _ = std::fs::remove_file(local_plist_path());
}

// ── launchctl ─────────────────────────────────────────────────────────────

fn uid() -> Result<String, String> {
    let out = Command::new("/usr/bin/id").arg("-u").output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn launchctl(args: &[&str]) -> Result<(), String> {
    let out = Command::new("/bin/launchctl").args(args).output().map_err(|e| format!("launchctl: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("launchctl {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// (Re)loads the agent from `plist`; launchd starts it at once (KeepAlive implies RunAtLoad).
pub fn bootstrap(plist: &Path) -> Result<(), String> {
    let u = uid()?;
    let _ = launchctl(&["bootout", &format!("gui/{u}/{LABEL}")]);
    // bootout returns before the job is fully gone; a bootstrap right after can fail with "in progress".
    let mut last = String::new();
    for _ in 0..10 {
        match launchctl(&["bootstrap", &format!("gui/{u}"), &plist.to_string_lossy()]) {
            Ok(()) => return Ok(()),
            Err(e) => last = e,
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Err(last)
}

/// Starts the loaded job again (it may have exited cleanly after Stop Engine & Disconnect).
pub fn kickstart() -> Result<(), String> {
    let u = uid()?;
    launchctl(&["kickstart", &format!("gui/{u}/{LABEL}")])
}

pub fn bootout() {
    if let Ok(u) = uid() {
        let _ = launchctl(&["bootout", &format!("gui/{u}/{LABEL}")]);
    }
}

// ── a tiny HTTP client for the engine on 127.0.0.1 ───────────────────────

pub fn port_of(url: &str) -> Option<u16> {
    url.strip_prefix("http://127.0.0.1:")?.trim_end_matches('/').parse().ok()
}

/// One request to the local engine. No Origin header (we're not a browser); Host must match exactly.
pub fn http(url: &str, method: &str, path: &str, token: Option<&str>, body: Option<&str>) -> Result<(u16, String), String> {
    let port = port_of(url).ok_or("engine url must be http://127.0.0.1:<port>")?;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;
    let body = body.unwrap_or("");
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    if let Some(t) = token {
        req += &format!("Authorization: Bearer {t}\r\n");
    }
    if method != "GET" {
        req += &format!("Content-Type: application/json\r\nContent-Length: {}\r\n", body.len());
    }
    req += "\r\n";
    req += body;
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    parse_response(&raw)
}

pub fn parse_response(raw: &[u8]) -> Result<(u16, String), String> {
    let text = String::from_utf8_lossy(raw);
    let (head, rest) = text.split_once("\r\n\r\n").ok_or("malformed HTTP response")?;
    let status: u16 = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or("malformed status line")?;
    let chunked = head.lines().any(|l| l.to_ascii_lowercase().starts_with("transfer-encoding:") && l.to_ascii_lowercase().contains("chunked"));
    if !chunked {
        return Ok((status, rest.to_string()));
    }
    let mut body = String::new();
    let mut rest = rest;
    loop {
        let Some((size, after)) = rest.split_once("\r\n") else { break };
        let n = usize::from_str_radix(size.trim(), 16).map_err(|_| "bad chunk size")?;
        if n == 0 || after.len() < n {
            break;
        }
        body += &after[..n];
        rest = after[n..].strip_prefix("\r\n").unwrap_or(&after[n..]);
    }
    Ok((status, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plist_escapes_and_keeps_the_crash_restart_rule() {
        let spec = AgentSpec {
            program: vec!["/Apps/Reel & Forge.app/node".into(), "serve".into(), "--allow-origin".into(), "tauri://localhost".into()],
            env: vec![("PATH".into(), "/usr/bin:<x>".into())],
            log: PathBuf::from("/Users/a/Library/Logs/ReelForge/engine.log"),
        };
        let p = render_plist(&spec);
        assert!(p.contains("<string>/Apps/Reel &amp; Forge.app/node</string>"));
        assert!(p.contains("<string>/usr/bin:&lt;x&gt;</string>"));
        assert!(p.contains("<key>SuccessfulExit</key>\n    <false/>"));
        assert!(p.contains(&format!("<string>{LABEL}</string>")));
        assert_eq!(p.matches("<string>/Users/a/Library/Logs/ReelForge/engine.log</string>").count(), 2);
    }

    #[test]
    fn engine_file_needs_a_background_engine_on_loopback() {
        let ok = r#"{"pid":42,"url":"http://127.0.0.1:5123","token":"0123456789abcdef0123456789abcdef","version":"x","startedAt":"y","background":true}"#;
        let f = parse_engine_file(ok).unwrap();
        assert_eq!((f.pid, port_of(&f.url)), (42, Some(5123)));
        assert!(parse_engine_file(&ok.replace("127.0.0.1", "example.com")).is_none());
        assert!(parse_engine_file(&ok.replace("\"background\":true", "\"background\":false")).is_none());
        assert!(parse_engine_file(&ok.replace("0123456789abcdef0123456789abcdef", "short")).is_none());
        assert!(parse_engine_file("not json").is_none());
    }

    #[test]
    fn http_responses_plain_and_chunked() {
        let plain = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true}";
        assert_eq!(parse_response(plain).unwrap(), (200, "{\"ok\":true}".to_string()));
        let chunked = b"HTTP/1.1 202 Accepted\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{\"a\":\r\n2\r\n1}\r\n0\r\n\r\n";
        assert_eq!(parse_response(chunked).unwrap(), (202, "{\"a\":1}".to_string()));
        assert!(parse_response(b"garbage").is_err());
    }

    #[test]
    fn proof_matches_the_engine() {
        // Same vector as packages/server/test/server.test.ts.
        assert_eq!(engine_proof(&"t".repeat(48), &"0123456789abcdef".repeat(2)), "83c6871b5a83307ece2133512764426463758c7d191278f4d9e1310654f8a64f");
        assert_eq!(random_hex(16).unwrap().len(), 32);
        assert_ne!(random_hex(16), random_hex(16));
    }

    /// A listener that answers 200 to everything and records what it was sent.
    fn impostor(answer: impl Fn(&str) -> String + Send + 'static) -> (String, std::sync::mpsc::Receiver<String>) {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for c in l.incoming() {
                let Ok(mut c) = c else { break };
                let mut buf = [0u8; 4096];
                let n = c.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let body = answer(&req);
                let _ = tx.send(req);
                let _ = c.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes());
            }
        });
        (url, rx)
    }

    #[test]
    fn a_process_on_a_stale_port_gets_no_token() {
        let token = "0".repeat(32);
        let (url, rx) = impostor(|_| "{}".into());
        let f = EngineFile { pid: 1, url: url.clone(), token: token.clone(), background: true };
        assert!(probe(f).is_none(), "a listener that can't prove the token is not our engine");
        let seen: Vec<String> = rx.try_iter().collect();
        assert!(!seen.is_empty());
        assert!(seen.iter().all(|r| !r.contains(&token) && !r.to_ascii_lowercase().contains("authorization")), "{seen:?}");
        // A wrong proof is refused the same way.
        let (url, _rx) = impostor(|_| r#"{"proof":"00"}"#.into());
        assert!(!proves(&url, &token));
    }

    #[test]
    fn the_engine_that_holds_the_token_is_accepted() {
        let token = "k".repeat(40);
        let t = token.clone();
        let (url, rx) = impostor(move |req| {
            match req.split_once("nonce=").map(|(_, r)| r.split(' ').next().unwrap_or("").to_string()) {
                Some(n) => format!(r#"{{"proof":"{}"}}"#, engine_proof(&t, &n)),
                None => "{}".into(),
            }
        });
        let f = EngineFile { pid: 1, url, token: token.clone(), background: true };
        assert!(probe(f).is_some());
        let seen: Vec<String> = rx.try_iter().collect();
        assert!(!seen[0].contains(&token), "the token is only sent after the proof");
        assert!(seen[1].contains(&format!("Bearer {token}")));
    }
}
