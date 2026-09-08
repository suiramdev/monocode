//! Project scripts that run around a worktree's life: setup right after
//! MonoCode creates one, teardown right before it removes one. Output is
//! captured rather than streamed — both ends are short-lived steps the UI
//! reports on, and teardown has to finish before the folder disappears.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::fs::expand_home;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRun {
    /// Exit status; -1 when a signal took the script down.
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Long enough for a dependency install, short enough that a script waiting on
/// input cannot hold a session teardown forever.
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(600);
const POLL: Duration = Duration::from_millis(50);
/// Only the tail is shown, so keeping more would just cost memory.
const MAX_OUTPUT: usize = 8 * 1024;

/// Run `script` in `cwd` through the user's shell.
#[tauri::command]
pub async fn run_worktree_script(
    script: String,
    cwd: String,
    env: HashMap<String, String>,
) -> Result<ScriptRun, String> {
    tauri::async_runtime::spawn_blocking(move || run_script(&script, &cwd, &env))
        .await
        .map_err(|e| e.to_string())?
}

fn run_script(script: &str, cwd: &str, env: &HashMap<String, String>) -> Result<ScriptRun, String> {
    let script = script.trim();
    if script.is_empty() {
        return Err("The script is empty.".into());
    }
    let dir = expand_home(cwd);
    if !dir.is_dir() {
        return Err(format!("{} is not a folder.", dir.display()));
    }

    let (program, args) = script_shell();
    let mut cmd = Command::new(&program);
    cmd.args(args)
        .arg(script)
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("MONOCODE", "1");
    for (key, value) in env {
        cmd.env(key, value);
    }
    crate::hide_window_console(&mut cmd);
    crate::harness::apply_gui_env(&mut cmd);
    crate::harness::isolate_child(&mut cmd);

    let mut child = crate::harness::spawn_managed(&mut cmd)
        .map_err(|e| format!("Could not run the script with {program}: {e}"))?;
    let pid = child.id();
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());

    let deadline = Instant::now() + SCRIPT_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Ok(ScriptRun {
                    code: status.code().unwrap_or(-1),
                    stdout: tail(collect(stdout)),
                    stderr: tail(collect(stderr)),
                });
            }
            Ok(None) => {}
            Err(e) => return Err(e.to_string()),
        }
        if Instant::now() >= deadline {
            // The shell's children hold the pipes, so kill the whole group.
            crate::harness::terminate_all(&[pid]);
            let _ = child.wait();
            return Err(format!(
                "The script did not finish within {} minutes.",
                SCRIPT_TIMEOUT.as_secs() / 60
            ));
        }
        thread::sleep(POLL);
    }
}

/// A pipe nobody reads fills and stops the script, so drain both from the start.
fn drain<R: Read + Send + 'static>(source: Option<R>) -> JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut source) = source {
            let _ = source.read_to_end(&mut buf);
        }
        buf
    })
}

fn collect(reader: JoinHandle<Vec<u8>>) -> Vec<u8> {
    reader.join().unwrap_or_default()
}

fn tail(bytes: Vec<u8>) -> String {
    let text = String::from_utf8_lossy(&bytes);
    let trimmed = text.trim_end();
    if trimmed.len() <= MAX_OUTPUT {
        return trimmed.to_string();
    }
    let mut start = trimmed.len() - MAX_OUTPUT;
    while start < trimmed.len() && !trimmed.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &trimmed[start..])
}

/// The shell a one-shot script wants: no login files, just `-c`.
fn script_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        if let Ok(comspec) = std::env::var("COMSPEC") {
            if !comspec.is_empty() {
                return (comspec, vec!["/C".into()]);
            }
        }
        ("cmd.exe".into(), vec!["/C".into()])
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|shell| !shell.is_empty())
            .unwrap_or_else(|| "/bin/sh".into());
        (shell, vec!["-c".into()])
    }
}

// The cases below are written in POSIX shell, the only shell a test can assume.
#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    fn run(script: &str, dir: &std::path::Path) -> Result<ScriptRun, String> {
        run_script(script, &dir.to_string_lossy(), &HashMap::new())
    }

    #[test]
    fn reports_output_and_exit_code() {
        let dir = std::env::temp_dir();
        let ok = run("echo hello", &dir).unwrap();
        assert_eq!(ok.code, 0);
        assert_eq!(ok.stdout, "hello");

        let failed = run("echo boom >&2; exit 3", &dir).unwrap();
        assert_eq!(failed.code, 3);
        assert_eq!(failed.stderr, "boom");
    }

    #[test]
    fn runs_in_the_folder_with_the_passed_environment() {
        let dir = std::env::temp_dir().join("monocode-script-env");
        std::fs::create_dir_all(&dir).unwrap();
        let mut env = HashMap::new();
        env.insert("MONOCODE_WORKTREE_BRANCH".to_string(), "alpha".to_string());
        let run = run_script(
            "printf '%s %s' \"$(basename \"$PWD\")\" \"$MONOCODE_WORKTREE_BRANCH\"",
            &dir.to_string_lossy(),
            &env,
        )
        .unwrap();
        assert_eq!(run.stdout, "monocode-script-env alpha");
    }

    #[test]
    fn refuses_an_empty_script_or_a_missing_folder() {
        let dir = std::env::temp_dir();
        assert_eq!(run("  \n ", &dir).unwrap_err(), "The script is empty.");
        assert!(run("echo hi", &dir.join("monocode-not-here"))
            .unwrap_err()
            .ends_with("is not a folder."));
    }

    #[test]
    fn keeps_only_the_tail_of_a_chatty_script() {
        let dir = std::env::temp_dir();
        let run = run("for i in $(seq 1 4000); do echo 0123456789; done", &dir).unwrap();
        assert_eq!(run.code, 0);
        assert!(run.stdout.starts_with('…'), "{}", &run.stdout[..32]);
        assert!(run.stdout.len() <= MAX_OUTPUT + 8, "{}", run.stdout.len());
    }
}
