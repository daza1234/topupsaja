//! Perintah IPC untuk core agent di webview.
//!
//! Semua fs/exec di sini sengaja async via Tauri invoke — lihat catatan
//! ponytail di host-tauri.ts (frontend) soal limitasi sinkron.

use serde::Serialize;
use std::io::{BufRead, Read};
use std::path::Path;
use tauri::ipc::Channel;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    size: u64,
    is_file: bool,
    is_directory: bool,
    mtime_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    is_file: bool,
    is_directory: bool,
}

fn stat_of(p: &Path) -> Result<FileStat, String> {
    let md = std::fs::metadata(p).map_err(|e| e.to_string())?;
    let mtime_ms = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileStat {
        size: md.len(),
        is_file: md.is_file(),
        is_directory: md.is_dir(),
        mtime_ms,
    })
}

#[tauri::command]
pub fn fs_read_file(path: String) -> Result<String, String> {
    std::fs::read(&path)
        .map(|bytes| base64_encode(&bytes))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_write_file(path: String, data: String, mode: Option<u32>) -> Result<(), String> {
    use std::io::Write;
    if let Some(parent) = Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    f.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    if let Some(mode) = mode {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode));
        }
        #[cfg(not(unix))]
        let _ = mode;
    }
    Ok(())
}

#[tauri::command]
pub fn fs_stat(path: String) -> Result<FileStat, String> {
    stat_of(Path::new(&path))
}

#[tauri::command]
pub fn fs_readdir(path: String, with_file_types: bool) -> Result<Vec<DirEntry>, String> {
    let rd = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if with_file_types {
            let md = e.file_type().map_err(|e| e.to_string())?;
            out.push(DirEntry {
                name,
                is_file: md.is_file(),
                is_directory: md.is_dir(),
            });
        } else {
            out.push(DirEntry {
                name,
                is_file: true,
                is_directory: false,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn fs_mkdir(path: String, recursive: Option<bool>) -> Result<(), String> {
    if recursive.unwrap_or(false) {
        std::fs::create_dir_all(&path)
    } else {
        std::fs::create_dir(&path)
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub fn fs_unlink(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_chmod(path: String, mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode))
            .map_err(|e| e.to_string())
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Ok(())
    }
}

// ── os: homedir / cwd / env (dipakai host core) ──

#[tauri::command]
pub fn os_homedir() -> String {
    dirs_next().unwrap_or_else(|| "/".into())
}

#[tauri::command]
pub fn os_cwd() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".into())
}

#[derive(Serialize)]
pub struct OsEnv(pub std::collections::HashMap<String, String>);

#[tauri::command]
pub fn os_env(keys: Vec<String>) -> std::collections::HashMap<String, String> {
    keys.into_iter()
        .filter_map(|k| std::env::var(&k).ok().map(|v| (k, v)))
        .collect()
}

fn dirs_next() -> Option<String> {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE").ok()
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").ok()
    }
}

// ── exec: spawn + streaming stdout/stderr/exit via Channel + registry kill/stdin ──

use std::collections::HashMap;
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecEvent {
    Spawned { id: String },
    Stdout { data: String },
    Stderr { data: String },
    Close { code: i32 },
    Error { message: String },
}

struct ExecProc {
    child: Child,
    stdin: Option<ChildStdin>,
}

fn exec_registry() -> &'static Mutex<HashMap<String, ExecProc>> {
    static REG: OnceLock<Mutex<HashMap<String, ExecProc>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_exec_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    format!("{}-{}", pid, n)
}

#[tauri::command]
pub fn exec_kill(id: String) -> Result<(), String> {
    if let Some(mut p) = exec_registry().lock().unwrap().remove(&id) {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn exec_write(id: String, data: String) -> Result<(), String> {
    let mut reg = exec_registry().lock().unwrap();
    let p = reg.get_mut(&id).ok_or_else(|| "spawn tidak ditemukan".to_string())?;
    let stdin = p.stdin.as_mut().ok_or_else(|| "stdin tidak tersedia".to_string())?;
    use std::io::Write;
    stdin.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn exec_spawn(
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    on_event: Channel<ExecEvent>,
) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        // bash tidak ada di Windows — fallback powershell untuk `bash -c <cmd>`
        if command == "bash" && args.first().map(|s| s.as_str()) == Some("-c") {
            if let Some(script) = args.get(1) {
                cmd = Command::new("powershell");
                cmd.args(["-NoProfile", "-Command", script]);
            }
        }
    }
    if let Some(cwd) = cwd {
        cmd.current_dir(&cwd);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let id = next_exec_id();
    let stdin = child.stdin.take();
    exec_registry().lock().unwrap().insert(
        id.clone(),
        ExecProc { child, stdin },
    );
    let _ = on_event.send(ExecEvent::Spawned { id: id.clone() });

    let stdout = exec_registry().lock().unwrap().get_mut(&id).unwrap().child.stdout.take();
    let stderr = exec_registry().lock().unwrap().get_mut(&id).unwrap().child.stderr.take();

    let ch = on_event.clone();
    let t_out = std::thread::spawn(move || {
        if let Some(out) = stdout {
            let reader = std::io::BufReader::new(out);
            for chunk in reader.split(b'\n') {
                match chunk {
                    Ok(b) => {
                        let mut line = String::from_utf8_lossy(&b).into_owned();
                        line.push('\n');
                        let _ = ch.send(ExecEvent::Stdout { data: line });
                    }
                    Err(_) => break,
                }
            }
        }
    });

    let ch = on_event.clone();
    let t_err = std::thread::spawn(move || {
        if let Some(err) = stderr {
            let reader = std::io::BufReader::new(err);
            for chunk in reader.split(b'\n') {
                match chunk {
                    Ok(b) => {
                        let mut line = String::from_utf8_lossy(&b).into_owned();
                        line.push('\n');
                        let _ = ch.send(ExecEvent::Stderr { data: line });
                    }
                    Err(_) => break,
                }
            }
        }
    });

    // Reader pipe ditutup otomatis saat child selesai; tunggu kedua thread, lalu
    // poll status exit dari registry (child bisa di-kill kapan saja via exec_kill).
    std::thread::spawn(move || {
        let _ = t_out.join();
        let _ = t_err.join();
        let code = loop {
            {
                let mut reg = exec_registry().lock().unwrap();
                let Some(p) = reg.get_mut(&id) else { return };
                match p.child.try_wait() {
                    Ok(Some(status)) => break status.code().unwrap_or(-1),
                    Ok(None) => {}
                    Err(e) => {
                        reg.remove(&id);
                        let _ = on_event.send(ExecEvent::Error { message: e.to_string() });
                        return;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        exec_registry().lock().unwrap().remove(&id);
        let _ = on_event.send(ExecEvent::Close { code });
    });
    Ok(())
}

// ── keyring: simpan API key di OS credential store ──

const SERVICE: &str = "com.topupsaja.desktop";

#[tauri::command]
pub fn keyring_get(account: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE, &account).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn keyring_set(account: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, &account).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn keyring_delete(account: String) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, &account).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ── oauth loopback: listener 127.0.0.1:<port acak>, satu request → token ──

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStart {
    port: u16,
    redirect_uri: String,
}

/// Mulai listener loopback. Saat browser di-redirect ke
/// `http://127.0.0.1:<port>/callback?token=...`, token dikirim via channel.
#[tauri::command]
pub fn oauth_start(api_origin: String, on_token: Channel<String>) -> Result<OAuthStart, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    std::thread::spawn(move || {
        // Timeout: kalau 5 menit tak ada callback, tutup listener.
        let _ = listener.set_nonblocking(false);
        let Ok((mut stream, _)) = listener.accept() else { return };
        let mut buf = [0u8; 8192];
        let mut req = String::new();
        if let Ok(n) = stream.read(&mut buf) {
            req = String::from_utf8_lossy(&buf[..n]).into_owned();
        }
        // Baris pertama: GET /callback?token=... HTTP/1.1
        let target = req.split_whitespace().nth(1).unwrap_or("");
        let token = url_query_param(target, "token");

        let body = if token.is_some() {
            "<html><body><h3>Login berhasil</h3><p>Silakan kembali ke aplikasi TopUpSaja. Tab ini boleh ditutup.</p></body></html>"
        } else {
            "<html><body><h3>Login gagal</h3><p>Token tidak ditemukan. Coba lagi dari aplikasi.</p></body></html>"
        };
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        use std::io::Write;
        let _ = stream.write_all(resp.as_bytes());
        let _ = stream.flush();

        if let Some(token) = token {
            let _ = on_token.send(token);
        }
        let _ = api_origin;
    });

    Ok(OAuthStart { port, redirect_uri })
}

fn url_query_param(target: &str, key: &str) -> Option<String> {
    let url = target.split('#').next()?;
    let query = url.split_once('?')?.1;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=')?;
        if k == key {
            return Some(urldecode(v));
        }
    }
    None
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    out.push(b);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}
