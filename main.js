const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { LEVELS, compressToTarget } = require('./compressor');

/** 解析捆绑的 Ghostscript 可执行文件路径 */
function resolveGsPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'ghostscript', 'bin', 'gswin64c.exe');
  }
  return path.join(__dirname, 'resources', 'ghostscript', 'bin', 'gswin64c.exe');
}

const GS_PATH = resolveGsPath();

function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    frame: false,
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

/* ---------------- IPC ---------------- */

// 选择文件
ipcMain.handle('select-files', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择 PDF 文件',
    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled) return [];
  return result.filePaths.filter((p) => {
    try {
      return fs.statSync(p).isFile() && path.extname(p).toLowerCase() === '.pdf';
    } catch {
      return false;
    }
  });
});

// 压缩单个文件：arg = { filePath, level }
// 输出目录名：在源文件所在目录下自动创建
const OUTPUT_DIR_NAME = '压缩后';

/**
 * 计算输出路径：与原文件同名，输出到源目录下的「压缩后」文件夹。
 * - 目标已存在时自动追加序号（避免覆盖之前的压缩结果）
 * - 源文件本身就在输出文件夹里时，改名输出以保护源文件
 */
function buildOutputPath(filePath) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const outDir = path.join(dir, OUTPUT_DIR_NAME);
  fs.mkdirSync(outDir, { recursive: true });

  let candidate = path.join(outDir, `${base}${ext}`);
  if (candidate.toLowerCase() === filePath.toLowerCase()) {
    candidate = path.join(outDir, `${base} - 已压缩${ext}`);
  }
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(outDir, `${base}(${n})${ext}`);
    n++;
  }
  return candidate;
}

ipcMain.handle('compress-file', async (event, { filePath, level }) => {
  const cfg = LEVELS[level] || LEVELS.p50;
  let outputPath;
  try {
    outputPath = buildOutputPath(filePath);
  } catch (err) {
    return { ok: false, error: `无法创建输出文件夹: ${err.message}`, outputPath: null };
  }

  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfc-'));
    const r = await compressToTarget(GS_PATH, filePath, outputPath, cfg, tmpDir);
    if (!r.ok) {
      return { ok: false, error: r.error, outputPath };
    }
    return {
      ok: true,
      skipped: !!r.skipped,
      originalSize: r.originalSize,
      newSize: r.newSize,
      achieved: r.achieved,
      metTarget: !!r.metTarget,
      target: cfg.target,
      level: cfg.label,
      res: r.res || null,
      outputPath: r.skipped ? null : outputPath,
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err), outputPath };
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }
});

// 在资源管理器中显示文件
ipcMain.handle('show-in-folder', (_event, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
  }
});

// 窗口控制（无边框窗口）
ipcMain.on('win-minimize', (event) => event.sender.getOwnerBrowserWindow().minimize());
ipcMain.on('win-maximize', (event) => {
  const win = event.sender.getOwnerBrowserWindow();
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win-close', (event) => event.sender.getOwnerBrowserWindow().close());

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
