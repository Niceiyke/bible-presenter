# Bible Presenter (Desktop) - VPS Build Guide

This guide explains how to use a Linux VPS to build the **Windows Offline-Ready Installer** for Bible Presenter.

## Prerequisites

- **Docker:** Installed and running (Required for Wine/Windows cross-compilation without `sudo`).
- **Memory:** Minimum 4GB RAM (Whisper model loading and Electron building is resource-intensive).
- **Disk Space:** ~5GB (Includes Docker images, AI models, and build artifacts).

## Step 1: Prepare the Environment

Clone the repository and enter the desktop directory:

```bash
git clone https://github.com/Niceiyke/bible-presenter.git
cd bible-presenter/desktop
```

## Step 2: Pre-download AI Models (Offline Support)

To ensure the app works 100% offline, you must download the Whisper model weights into the project folder. Use the following Docker command to download them without needing a local Python setup:

```bash
docker run --rm 
  -v $(pwd)/src/core-engine:/engine 
  -w /engine 
  python:3.10-slim 
  /bin/bash -c "pip install faster-whisper && python download_model.py"
```

## Step 3: Build the Windows Installer

We use a specialized Electron Builder image that contains **Wine** to generate the Windows `.exe` on Linux.

```bash
docker run --rm 
  -v $(pwd):/project 
  -w /project 
  electronuserland/builder:wine 
  /bin/bash -c "npm install && npm run build -- --win"
```

## Step 4: Retrieve the Installer

Once the build finishes, your installer will be located at:
`desktop/release/Bible Presenter-Setup-1.0.0.exe`

Download it to your local machine using SCP:

```bash
scp user@your-vps-ip:/path/to/bible-presenter/desktop/release/Bible\ Presenter-Setup-1.0.0.exe ~/Downloads/
```

## Technical Architecture

- **Frontend:** React 19 (Vite)
- **Engine:** Python 3.11 with `faster-whisper`
- **Database:** Local SQLite (`bible.db`)
- **Bridge:** Electron Main-to-Python via Binary IPC
- **Compilation:** electron-builder + Wine (via Docker)
