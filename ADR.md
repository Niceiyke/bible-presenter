# ADR 001: Pivot to Multi-Window Desktop Architecture

## Status
Proposed

## Context
The original web-based architecture (FastAPI + Next.js) introduced unacceptable latency (2-5s) for real-time speech-to-scripture detection and struggled with professional video mixer integration. Video mixers require stable window handles and multi-monitor awareness which browsers cannot reliably provide.

## Decision
We will pivot to a **Desktop Application** using **Electron + React 19** with a **Python Sidecar** for AI inference.

### Architecture Highlights:
1. **Frontend:** Electron (Main Process) + React 19 (Renderer Process).
2. **Multi-Window:** 
   - **Operator Window:** Primary display for transcription and controls.
   - **Output Window:** Secondary display (borderless, topmost) for "Mixer-Friendly" scripture projection.
3. **AI Core (Sidecar):** A local Python process running `faster-whisper` and `SQLite/Vector Search`.
4. **Communication:** Local IPC (Inter-Process Communication) between Electron and Python.

## Consequences
- **Positive:** Sub-200ms latency, professional video mixer compatibility, offline-first capability.
- **Negative:** Increased distribution size (embedded Python/Models), requires local hardware (GPU recommended).
