# 📖 Bible Presenter (Desktop Edition)

**Bible Presenter** is a professional, real-time broadcast tool designed for churches and live streams. It uses AI-powered speech recognition to automatically detect Bible references during a sermon and project them onto a secondary display or video mixer with sub-200ms latency.

![Architecture: Desktop Pivot](https://img.shields.io/badge/Architecture-Desktop--First-blue?style=for-the-badge)
![Tech: Electron + React 19](https://img.shields.io/badge/Frontend-Electron%20%2B%20React%2019-indigo?style=for-the-badge)
![AI: Faster--Whisper](https://img.shields.io/badge/AI-Faster--Whisper-gold?style=for-the-badge)

---

## 🚀 Key Features

### 🎙️ Real-time "Hands-Free" Detection
- **AI Transcription:** Uses `faster-whisper` (CTranslate2) for near-instant speech-to-text.
- **Auto-Scripture Detection:** Automatically identifies references like *"John 3:16"* or *"First Corinthians 13"* as they are spoken.
- **Local Inference:** All AI processing happens locally on your machine—no internet required, zero cloud latency.

### 📺 Broadcast-Pro Output (PowerPoint Style)
- **Multi-Monitor Awareness:** Automatically detects secondary displays (projectors/TVs) and launches a clean, borderless output window.
- **Mixer Friendly:** Provides a stable, persistent window handle (`Bible Presenter - Output`) that OBS, vMix, and ATEM software can "lock" onto.
- **Aesthetic Typography:** High-contrast, "Theology Modern" design using **Crimson Pro** (Serif) for scripture and **Inter** (Sans) for references.

### 🛠️ Operator Control Center
- **Live Feed:** See exactly what the AI is hearing in real-time.
- **Verse History:** A sidebar of all detected verses for quick projection.
- **Manual Override:** Search and project any verse manually in milliseconds via the integrated SQLite FTS5 engine.

---

## 🏗️ The "Staff Engineer" Architecture

This project was pivoted from a web-based monolith to a **Multi-Window Desktop Architecture** to solve critical latency and hardware integration issues:

1.  **Electron Main Process:** Orchestrates the "Operator" and "Output" windows and manages the lifecycle of the Python sidecar.
2.  **Python Sidecar:** A dedicated background process running the AI models and the 7.6MB SQLite Bible database.
3.  **Binary IPC Pipe:** A high-speed binary bridge that streams raw 16kHz PCM audio from the frontend microphone to the Python engine.
4.  **Local Persistence:** Uses a pre-indexed SQLite database for sub-10ms scripture retrieval.

---

## 🛠️ Installation & Setup

### Prerequisites
- **Node.js:** v20+ 
- **Python:** 3.10+ (with `pip`)
- **Git:** For cloning the repo

### 1. Clone the Repository
```bash
git clone git@github.com:Niceiyke/bible-presenter.git
cd bible-presenter/desktop
```

### 2. Install Frontend Dependencies
```bash
npm install
```

### 3. Setup Python Sidecar
```bash
# Recommended: Create a virtual environment
cd src/core-engine
pip install faster-whisper numpy
```

### 4. Launch in Development Mode
```bash
# From the /desktop directory
npm run dev
```

---

## 📦 Building for Windows (`.exe`)

To package this as a standalone Windows application:
1.  Run `npm run build`.
2.  The installer will be generated in the `desktop/release` directory.
3.  Install `Bible-Presenter-Setup-1.0.0.exe` on any machine.

---

## 🎨 Design Tokens (Theology Modern)
- **Primary Indigo:** `#1E1B4B` (Backgrounds)
- **Bible Gold:** `#FACC15` (Accents & References)
- **Typography:** 
  - Scripture: *Crimson Pro* (Serif)
  - Interface: *Inter* (Sans-serif)

---

## ⚖️ License
MIT License - Created for the Global Church.
