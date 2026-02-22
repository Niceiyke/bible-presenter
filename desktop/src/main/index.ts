import { app, BrowserWindow, screen, ipcMain } from 'electron';
import { join } from 'path';
import { spawn, ChildProcess } from 'child_process';

let operatorWindow: BrowserWindow | null = null;
let outputWindow: BrowserWindow | null = null;
let pythonSidecar: ChildProcess | null = null;

function createOperatorWindow() {
  operatorWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: "Bible Presenter - Operator",
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    operatorWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    operatorWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function createOutputWindow() {
  const displays = screen.getAllDisplays();
  const externalDisplay = displays.find((display) => {
    return display.bounds.x !== 0 || display.bounds.y !== 0;
  });

  outputWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    x: externalDisplay ? externalDisplay.bounds.x : 0,
    y: externalDisplay ? externalDisplay.bounds.y : 0,
    frame: false,
    fullscreen: !!externalDisplay,
    transparent: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: "Bible Presenter - Output",
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    outputWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/output`);
  } else {
    outputWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'output' });
  }
}

function startPythonSidecar() {
  const isDev = !app.isPackaged;
  const pythonPath = isDev ? 'python3' : join(process.resourcesPath, 'engine.exe'); // In a real build, we'd package engine.py to an .exe
  const engineScript = isDev ? join(__dirname, '../core-engine/engine.py') : ''; 
  
  // Resolve database path relative to the engine
  const dbDir = isDev ? join(__dirname, '../core-engine/bible_data') : join(process.resourcesPath, 'bible_data');
  
  const args = isDev ? [engineScript] : [];
  pythonSidecar = spawn(pythonPath, args, {
    env: { ...process.env, DB_PATH_OVERRIDE: dbDir }
  });

  pythonSidecar.stdout?.on('data', (data) => {
    try {
      const response = JSON.parse(data.toString());
      if (response.type === 'search_result' && response.data) {
        operatorWindow?.webContents.send('verse-found', response.data);
      } else if (response.type === 'transcription') {
        operatorWindow?.webContents.send('transcription-update', response.text);
      }
    } catch (e) {
      console.log('Python Engine Output:', data.toString());
    }
  });

  pythonSidecar.stderr?.on('data', (data) => {
    console.error('Python Engine Error:', data.toString());
  });
}

ipcMain.on('audio-chunk', (event, buffer: ArrayBuffer) => {
  if (pythonSidecar && pythonSidecar.stdin) {
    // Write binary audio data to stdin
    // Prefix with 'AUDIO:' to distinguish from JSON commands
    const audioData = Buffer.from(buffer);
    const header = Buffer.from(`AUDIO:${audioData.length}\n`);
    pythonSidecar.stdin.write(header);
    pythonSidecar.stdin.write(audioData);
  }
});

ipcMain.on('search-verse', (event, reference) => {
  pythonSidecar?.stdin?.write(JSON.stringify({ action: 'search', reference }) + '\n');
});

ipcMain.on('update-verse', (event, verse) => {
  outputWindow?.webContents.send('verse-updated', verse);
});

app.whenReady().then(() => {
  createOperatorWindow();
  createOutputWindow();
  startPythonSidecar();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createOperatorWindow();
      createOutputWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
  pythonSidecar?.kill();
});
