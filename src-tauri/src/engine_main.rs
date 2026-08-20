//! Wordlyte engine sidecar (Phase A2).
//!
//! The standalone Rust video engine process. Spawned by the Tauri shell; owns
//! authoritative presentation state and will own the compositor, transports,
//! and NDI. Speaks the newline-delimited JSON-RPC contract in
//! `engine/ipc.rs` over stdio:
//!
//! - stdin: one `EngineRequest` JSON frame per line.
//! - stdout: for each request, the engine writes every `EngineEventFrame` the
//!   mutation emitted (one per line), then the `EngineResponse` line.
//!
//! `stderr` carries logs/panics only. On `Shutdown` (or EOF) the engine flushes
//! and exits 0.
//!
//! Run standalone for smoke tests:
//!   echo '{"id":1,"command":{"cmd":"ping"}}' | cargo run --bin wordlyte-engine

use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use wordlyte_lib::engine::ipc::{EngineRequest, EngineResponse};
use wordlyte_lib::engine::runtime::{dispatch, EngineRuntime};

fn main() {
    // Logs go to stderr so stdout stays a clean JSON channel.
    eprintln!("[engine] wordlyte-engine starting (protocol v{})", wordlyte_lib::engine::ipc::ENGINE_PROTOCOL_VERSION);

    // The console passes the app data dir as argv[1] so prop-path validation
    // matches the console's. Fall back to LOCALAPPDATA for standalone runs.
    let app_data_dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .or_else(|| std::env::var("LOCALAPPDATA").map(PathBuf::from).ok())
        .unwrap_or_else(std::env::temp_dir);
    let runtime = match EngineRuntime::new_with_windows(app_data_dir.clone()) {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("[engine] FATAL: could not initialize runtime: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("[engine] runtime ready (data dir: {:?})", app_data_dir);

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut stdout = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[engine] stdin read error: {e}");
                break;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let request: EngineRequest = match serde_json::from_str(trimmed) {
            Ok(req) => req,
            Err(e) => {
                eprintln!("[engine] dropping unparseable frame: {e}");
                let response = EngineResponse::err(0, 0, "parse_error", "Malformed JSON-RPC frame.");
                write_frame(&mut stdout, &response);
                continue;
            }
        };

        let is_shutdown = matches!(request.command, wordlyte_lib::engine::ipc::EngineCommand::Shutdown);
        let (response, events) = dispatch(&runtime, request.id, request.command);

        for frame in &events {
            write_frame(&mut stdout, frame);
        }
        write_frame(&mut stdout, &response);

        if is_shutdown {
            eprintln!("[engine] shutdown requested; exiting");
            break;
        }
    }

    eprintln!("[engine] stdin closed; exiting 0");
}

fn write_frame<T: serde::Serialize>(stdout: &mut impl Write, frame: &T) {
    if let Ok(line) = serde_json::to_string(frame) {
        let _ = writeln!(stdout, "{}", line);
        let _ = stdout.flush();
    }
}