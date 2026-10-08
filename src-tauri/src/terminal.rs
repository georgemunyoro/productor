//! Pseudo-terminals for the workspace terminal panel.

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};

struct Terminal {
    workspace_id: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals {
    open: Mutex<HashMap<String, Terminal>>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 }
}

impl Terminals {
    /// Starts a login shell in `cwd`, or runs `command` in one if given.
    pub fn open<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        workspace_id: &str,
        cwd: &Path,
        cols: u16,
        rows: u16,
        command: Option<String>,
        env: &[(&str, String)],
    ) -> Result<String, String> {
        let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut cmd = CommandBuilder::new(&shell);
        match &command {
            Some(command) => cmd.args(["-lic", command]),
            None => cmd.arg("-l"),
        }
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (name, value) in env {
            cmd.env(name, value);
        }
        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let id = uuid::Uuid::new_v4().to_string();
        self.open.lock().unwrap().insert(
            id.clone(),
            Terminal { workspace_id: workspace_id.to_string(), master: pair.master, writer, child },
        );

        let app = app.clone();
        let reader_id = id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        // Chunks can split multi-byte characters, so bytes are
                        // sent as-is and decoded by the terminal emulator.
                        let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        let _ = app.emit("term-output", json!({ "id": reader_id, "data": data }));
                    }
                }
            }
            app.state::<crate::AppState>().terminals.open.lock().unwrap().remove(&reader_id);
            let _ = app.emit("term-exit", json!({ "id": reader_id }));
        });
        Ok(id)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let mut open = self.open.lock().unwrap();
        let term = open.get_mut(id).ok_or("terminal has exited")?;
        term.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        term.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let open = self.open.lock().unwrap();
        let term = open.get(id).ok_or("terminal has exited")?;
        term.master.resize(size(cols, rows)).map_err(|e| e.to_string())
    }

    pub fn close(&self, id: &str) {
        if let Some(mut term) = self.open.lock().unwrap().remove(id) {
            let _ = term.child.kill();
        }
    }

    pub fn close_all(&self) {
        for (_, mut term) in self.open.lock().unwrap().drain() {
            let _ = term.child.kill();
        }
    }

    pub fn close_workspace(&self, workspace_id: &str) {
        let mut open = self.open.lock().unwrap();
        open.retain(|_, term| {
            let keep = term.workspace_id != workspace_id;
            if !keep {
                let _ = term.child.kill();
            }
            keep
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tauri::Listener;

    #[test]
    fn runs_a_command_and_reports_output_and_exit() {
        let app = tauri::test::mock_app();
        app.manage(crate::AppState {
            store: Mutex::new(crate::store::Store::load(std::env::temp_dir().join(format!("productor-term-{}", uuid::Uuid::new_v4())))),
            agents: Default::default(),
            terminals: Default::default(),
            prs: Default::default(),
            problems: Default::default(),
        });
        let output = Arc::new(Mutex::new(Vec::<u8>::new()));
        let exited = Arc::new(Mutex::new(false));
        let sink = output.clone();
        app.listen("term-output", move |event| {
            let payload: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
            let bytes = base64::engine::general_purpose::STANDARD.decode(payload["data"].as_str().unwrap()).unwrap();
            sink.lock().unwrap().extend(bytes);
        });
        let flag = exited.clone();
        app.listen("term-exit", move |_| *flag.lock().unwrap() = true);

        let state = app.state::<crate::AppState>();
        let cwd = std::env::temp_dir();
        let id = state
            .terminals
            .open(app.handle(), "w", &cwd, 80, 24, Some("echo productor-$((6*7)); pwd".into()), &[])
            .unwrap();
        state.terminals.resize(&id, 100, 30).ok();

        for _ in 0..100 {
            if *exited.lock().unwrap() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let text = String::from_utf8_lossy(&output.lock().unwrap()).to_string();
        assert!(*exited.lock().unwrap(), "terminal never exited; output: {text}");
        assert!(text.contains("productor-42"), "unexpected output: {text}");
        assert!(state.terminals.write(&id, "x").is_err(), "exited terminals are forgotten");
    }
}
