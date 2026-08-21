//! Engine client (Phase A2) — spawn/teardown + request/event relay.
//!
//! [`EngineClient`] manages the `wordlyte-engine` sidecar process from the Tauri
//! shell: it spawns the binary, owns the stdio channels, correlates responses
//! to requests by id, and relays the engine's event frames back with each
//! reply. This is the process-boundary half of the Phase A2 skeleton — the
//! console's display commands still run locally (`Engine` over `AppState`)
//! until Phase A's command rewiring; this client proves the spawn/teardown +
//! framing contract and gives the relay a home to grow into.

use crate::engine::ipc::{
    EngineCommand, EngineEventFrame, EngineRequest, EngineResponse,
};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;

/// A relayed engine response with the events that preceded it (drained in
/// order, so the console's `PresentationSync` can replay them safely).
#[derive(Debug, Clone, Serialize)]
pub struct EngineReply {
    pub response: EngineResponse,
    pub events: Vec<EngineEventFrame>,
}

enum CommandMessage {
    /// Write a request line to the sidecar and register `reply` against `id`.
    Invoke { id: u64, command: EngineCommand },
    Shutdown,
}

/// State shared between the write thread, the read thread, and the public API.
struct Inner {
    tx: Sender<CommandMessage>,
    next_id: Mutex<u64>,
    /// Pending replies keyed by request id. The reader thread accumulates event
    /// frames against the most recent pending request and resolves it when the
    /// matching response frame arrives (the engine always writes a request's
    /// events before its response, so ordering is preserved).
    pending: Mutex<HashMap<u64, PendingReply>>,
    child: Mutex<Option<Child>>,
    reader: Mutex<Option<JoinHandle<()>>>,
}

/// A reply being accumulated for one in-flight request.
struct PendingReply {
    reply: Sender<EngineReply>,
    events: Vec<EngineEventFrame>,
}

/// Manages the engine sidecar process and the JSON-RPC channel to it.
#[derive(Clone)]
pub struct EngineClient {
    inner: Arc<Inner>,
}

impl EngineClient {
    /// Spawns `wordlyte-engine` with the given app data dir (argv[1]) and
    /// resource path (argv[2], used to resolve the bundled `bin/ffmpeg.exe`).
    /// `bin_path` is the path to the sidecar executable; callers resolve it via
    /// the resource dir / `current_exe` dir.
    pub fn spawn(
        bin_path: &std::path::Path,
        app_data_dir: &std::path::Path,
        resource_path: &std::path::Path,
    ) -> Result<Self, String> {
        if !bin_path.exists() {
            return Err(format!("Engine sidecar not found at {:?}", bin_path));
        }

        let mut child = Command::new(bin_path)
            .arg(app_data_dir)
            .arg(resource_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Failed to spawn engine sidecar: {e}"))?;

        let stdin = child.stdin.take().ok_or("Engine sidecar stdin not available")?;
        let stdout = child.stdout.take().ok_or("Engine sidecar stdout not available")?;

        let (tx, rx): (Sender<CommandMessage>, Receiver<CommandMessage>) = mpsc::channel();
        let inner = Arc::new(Inner {
            tx,
            next_id: Mutex::new(1),
            pending: Mutex::new(HashMap::new()),
            child: Mutex::new(Some(child)),
            reader: Mutex::new(None),
        });

        spawn_writer(stdin, rx);
        let reader = spawn_reader(stdout, Arc::clone(&inner));
        *inner.reader.lock() = Some(reader);

        Ok(Self { inner })
    }

    /// Sends a command and waits for its response (blocking). Event frames the
    /// engine emitted for this command ride along in [`EngineReply`].
    pub fn invoke(&self, command: EngineCommand) -> Result<EngineReply, String> {
        let id = {
            let mut next = self.inner.next_id.lock();
            let id = *next;
            *next += 1;
            id
        };
        let (reply_tx, reply_rx) = mpsc::channel();
        self.inner.pending.lock().insert(id, PendingReply { reply: reply_tx, events: Vec::new() });
        self.inner
            .tx
            .send(CommandMessage::Invoke { id, command })
            .map_err(|_| "Engine sidecar channel closed".to_string())?;
        reply_rx.recv().map_err(|_| "Engine sidecar died before replying".to_string())
    }

    /// Requests a clean shutdown: sends `Shutdown` (closing stdin makes the
    /// engine read EOF and exit 0), waits for the reader to see EOF, and reaps
    /// the child.
    pub fn shutdown(&self) {
        let _ = self.inner.tx.send(CommandMessage::Shutdown);
        if let Some(mut child) = self.inner.child.lock().take() {
            let _ = child.wait();
        }
        if let Some(reader) = self.inner.reader.lock().take() {
            let _ = reader.join();
        }
    }

    /// True if the sidecar process is still running.
    pub fn is_running(&self) -> bool {
        match self.inner.child.lock().as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        }
    }
}

// No `Drop`: `EngineClient` is `Clone` and hot paths clone it for one-off
// invokes (`commands/misc.rs`, `sync_engine_presentation`) — a `Drop` that
// shut the sidecar down would kill the engine the first time such a temporary
// goes out of scope. Teardown is explicit instead: `main.rs` calls
// `shutdown()` on `RunEvent::Exit`, and if the console dies abruptly the
// sidecar's stdin pipe closes and the engine exits itself on EOF.

fn spawn_writer(mut stdin: ChildStdin, rx: Receiver<CommandMessage>) {
    std::thread::spawn(move || {
        while let Ok(msg) = rx.recv() {
            match msg {
                CommandMessage::Invoke { id, command } => {
                    let request = EngineRequest { id, command };
                    let line = serde_json::to_string(&request).unwrap_or_default();
                    if writeln!(stdin, "{}", line).is_err() {
                        // Sidecar is gone — fail every pending reply.
                        break;
                    }
                    let _ = stdin.flush();
                }
                CommandMessage::Shutdown => break,
            }
        }
        // Dropping `stdin` makes the engine read EOF and exit 0.
    });
}

fn spawn_reader(stdout: ChildStdout, inner: Arc<Inner>) -> JoinHandle<()> {
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if line.trim().is_empty() {
                continue;
            }

            // Event frames attach to the most recent pending request (the
            // engine writes a request's events before its response).
            if let Ok(frame) = serde_json::from_str::<EngineEventFrame>(&line) {
                let mut pending = inner.pending.lock();
                if let Some(id) = pending.keys().next().cloned() {
                    if let Some(p) = pending.get_mut(&id) {
                        p.events.push(frame);
                    }
                }
                continue;
            }

            // Response frames resolve the matching pending reply, delivering
            // the accumulated events alongside it.
            if let Ok(response) = serde_json::from_str::<EngineResponse>(&line) {
                if let Some(p) = inner.pending.lock().remove(&response.id) {
                    let _ = p.reply.send(EngineReply { response, events: p.events });
                }
                continue;
            }
        }

        // EOF: fail every still-pending reply so callers never hang.
        let pending = std::mem::take(&mut *inner.pending.lock());
        for (id, p) in pending {
            let _ = p.reply.send(EngineReply {
                response: EngineResponse::err(id, 0, "engine_unavailable", "Engine sidecar exited"),
                events: p.events,
            });
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_version_constant_matches() {
        // v6 (Phase H): MediaControl + media_ended/media_failed events.
        assert_eq!(crate::engine::ipc::ENGINE_PROTOCOL_VERSION, 6);
    }

    #[test]
    fn engine_reply_serializes_response_and_events() {
        let reply = EngineReply {
            response: EngineResponse::ok(7, 3),
            events: Vec::new(),
        };
        let v = serde_json::to_value(&reply).unwrap();
        assert_eq!(v["response"]["id"], 7);
        assert_eq!(v["response"]["revision"], 3);
    }

    #[test]
    fn invoke_fails_cleanly_when_channel_is_dead() {
        // Simulate a client whose writer thread already exited (channel closed).
        let (tx, rx) = mpsc::channel::<CommandMessage>();
        drop(rx);
        let client = EngineClient {
            inner: Arc::new(Inner {
                tx,
                next_id: Mutex::new(1),
                pending: Mutex::new(HashMap::new()),
                child: Mutex::new(None),
                reader: Mutex::new(None),
            }),
        };
        let err = client.invoke(EngineCommand::Ping).unwrap_err();
        assert!(err.contains("Engine sidecar channel closed"), "got: {err}");
    }

    #[cfg(windows)]
    #[test]
    fn dropping_a_clone_keeps_the_sidecar_running() {
        // Regression: `Drop` used to call `shutdown()`, so any temporary clone
        // (engine_invoke / sync_engine_presentation) killed the shared
        // sidecar. A dropped clone must leave the process running; only an
        // explicit `shutdown()` may stop it.
        let mut child = Command::new("cmd")
            .args(["/q"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn cmd stand-in");
        let stdin = child.stdin.take().expect("cmd stdin");
        let stdout = child.stdout.take().expect("cmd stdout");
        let (tx, rx) = mpsc::channel();
        let inner = Arc::new(Inner {
            tx,
            next_id: Mutex::new(1),
            pending: Mutex::new(HashMap::new()),
            child: Mutex::new(Some(child)),
            reader: Mutex::new(None),
        });
        spawn_writer(stdin, rx);
        *inner.reader.lock() = Some(spawn_reader(stdout, Arc::clone(&inner)));

        let client = EngineClient { inner };
        let clone = client.clone();
        drop(clone);
        assert!(
            client.is_running(),
            "dropping a clone must not stop the sidecar"
        );

        client.shutdown();
        assert!(!client.is_running(), "explicit shutdown must stop it");
    }
}