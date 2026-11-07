use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// One running `ping -t` per target id.
#[derive(Default)]
struct Pings(Mutex<HashMap<String, Child>>);

#[derive(Clone, serde::Serialize)]
struct PingLine {
    id: String,
    line: String,
    ok: Option<bool>,
    ms: Option<u32>,
}

/// Classify a ping.exe line by its shape, not its words, so any Windows language works.
/// Some(true) = reply, Some(false) = failure, None = header line.
fn parse_line(line: &str) -> (Option<bool>, Option<u32>) {
    let line = line.trim();
    if line.is_empty() || line.ends_with(':') {
        return (None, None);
    }
    // "Destination host unreachable" also starts with "Reply from", but has no TTL=.
    if !line.contains("TTL=") {
        return (Some(false), None);
    }
    // "time=6ms" / "time<1ms": the word "time" is localized, "=", "<" and "ms" are not.
    let ms = line.split_whitespace().find_map(|w| {
        w.strip_suffix("ms")?.rsplit(['=', '<']).next()?.parse().ok()
    });
    (Some(true), ms)
}

fn stop(pings: &Pings, id: &str) {
    if let Some(mut child) = pings.0.lock().unwrap().remove(id) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn spawn(app: AppHandle, id: String, host: String) -> Result<(), String> {
    let pings = app.state::<Pings>();
    stop(&pings, &id);
    let mut cmd = Command::new("ping");
    cmd.args(["-t", &host]).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0000_0008); // DETACHED_PROCESS: no console, so no conhost.exe per target
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    let stdout = child.stdout.take().unwrap();
    pings.0.lock().unwrap().insert(id.clone(), child);

    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        // ping.exe writes in the OEM code page; lossy is fine for IPs, digits and ASCII words.
        while reader.read_until(b'\n', &mut buf).is_ok_and(|n| n > 0) {
            let line = String::from_utf8_lossy(&buf).trim().to_string();
            buf.clear();
            if line.is_empty() {
                continue;
            }
            let (ok, ms) = parse_line(&line);
            let _ = app.emit("ping", PingLine { id: id.clone(), line, ok, ms });
        }
        // ping.exe quit by itself (e.g. a host name that didn't resolve yet after boot): retry while still wanted.
        std::thread::sleep(Duration::from_secs(5));
        let wanted = app.state::<Pings>().0.lock().unwrap().get(&id).map(Child::id) == Some(pid);
        if wanted {
            let _ = spawn(app, id, host);
        }
    });
    Ok(())
}

#[tauri::command]
fn start_ping(app: AppHandle, pings: State<Pings>, id: String, host: String) -> Result<(), String> {
    stop(&pings, &id); // also when the new host is rejected, so an edited card never keeps pinging the old one
    // Passed as one argument, never through a shell; a leading '-' would be read as a ping flag.
    let valid = !host.is_empty()
        && host.len() <= 253
        && !host.starts_with('-')
        && host.chars().all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c));
    if !valid {
        return Err(format!("Invalid IP or host: {host}"));
    }
    spawn(app, id, host)
}

#[tauri::command]
fn stop_ping(pings: State<Pings>, id: String) {
    stop(&pings, &id);
}

/// Opens the project page in the default browser. The URL is fixed, so nothing the UI sends can reach the shell.
#[tauri::command]
fn open_github() {
    let _ = Command::new("explorer").arg("https://github.com/Zackcoww/matping").spawn();
}

/// Put MatPing in a kill-on-close job, so Windows kills every ping.exe it started
/// whenever MatPing exits, even on a crash or a forced "End task".
#[cfg(windows)]
fn kill_children_on_exit() {
    use windows_sys::Win32::System::{JobObjects::*, Threading::GetCurrentProcess};
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &raw const info as _,
            size_of_val(&info) as u32,
        );
        AssignProcessToJobObject(job, GetCurrentProcess());
        // The job handle is never closed on purpose: Windows closes it when MatPing's process ends.
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    kill_children_on_exit();
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(Pings::default())
        .invoke_handler(tauri::generate_handler![start_ping, stop_ping, open_github])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::parse_line;

    #[test]
    fn parses_ping_lines() {
        assert_eq!(parse_line("Reply from 103.163.160.1: bytes=32 time=6ms TTL=60"), (Some(true), Some(6)));
        assert_eq!(parse_line("Reply from 1.1.1.1: bytes=32 time<1ms TTL=59"), (Some(true), Some(1)));
        assert_eq!(parse_line("Antwort von 1.1.1.1: Bytes=32 Zeit=14ms TTL=59"), (Some(true), Some(14)));
        assert_eq!(parse_line("Request timed out."), (Some(false), None));
        assert_eq!(parse_line("Reply from 10.0.0.1: Destination host unreachable."), (Some(false), None));
        assert_eq!(parse_line("General failure."), (Some(false), None));
        assert_eq!(parse_line("Pinging 1.1.1.1 with 32 bytes of data:"), (None, None));
    }
}
