/* ===== 渲染进程逻辑 ===== */
const api = window.pdfAPI;

const dropZone = document.getElementById('dropZone');
const browseBtn = document.getElementById('browseBtn');
const levelPanel = document.getElementById('levelPanel');
const fileListEl = document.getElementById('fileList');
const summaryBar = document.getElementById('summaryBar');
const statBefore = document.getElementById('statBefore');
const statAfter = document.getElementById('statAfter');
const statSaved = document.getElementById('statSaved');
const startBtn = document.getElementById('startBtn');
const clearBtn = document.getElementById('clearBtn');
const toastEl = document.getElementById('toast');
const outputPanel = document.getElementById('outputPanel');
const outDefaultBtn = document.getElementById('outDefault');
const outCustomBtn = document.getElementById('outCustom');
const customRow = document.getElementById('customRow');
const customPathEl = document.getElementById('customPath');
const chooseFolderBtn = document.getElementById('chooseFolderBtn');
const dropTip = document.getElementById('dropTip');

let currentLevel = 'q_mid';
let outputMode = localStorage.getItem('outMode') === 'custom' ? 'custom' : 'default';
let customOutputDir = localStorage.getItem('outDir') || null;
let items = []; // { id, path, name, dir, size, status, result }
let uid = 0;
let isCompressing = false;

/* ---------- 工具 ---------- */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

/* ---------- 输出位置 ---------- */
function setOutputMode(mode) {
  outputMode = mode;
  localStorage.setItem('outMode', mode);
  outDefaultBtn.classList.toggle('active', mode === 'default');
  outCustomBtn.classList.toggle('active', mode === 'custom');
  customRow.classList.toggle('hidden', mode !== 'custom');
  updateDropTip();
}

function updateDropTip() {
  if (outputMode === 'custom' && customOutputDir) {
    dropTip.textContent = `压缩完成后，同名文件将输出到：${customOutputDir}`;
  } else if (outputMode === 'custom') {
    dropTip.textContent = '压缩完成后，同名文件将输出到您指定的文件夹（尚未选择）';
  } else {
    dropTip.textContent = '压缩完成后，同名文件将输出到原文件所在目录的「压缩后」文件夹';
  }
}

async function chooseFolder() {
  const dir = await api.selectOutputFolder();
  if (dir) {
    customOutputDir = dir;
    localStorage.setItem('outDir', dir);
    customPathEl.textContent = dir;
    customPathEl.title = dir;
    updateDropTip();
  }
}

outDefaultBtn.addEventListener('click', () => { if (!isCompressing) setOutputMode('default'); });
outCustomBtn.addEventListener('click', () => { if (!isCompressing) setOutputMode('custom'); });
chooseFolderBtn.addEventListener('click', (e) => { e.stopPropagation(); if (!isCompressing) chooseFolder(); });

/* ---------- 添加文件 ---------- */
async function addFiles(paths) {
  const pdfs = paths.filter((p) => p.toLowerCase().endsWith('.pdf'));
  const dupes = new Set(items.map((i) => i.path.toLowerCase()));
  let added = 0;
  for (const p of pdfs) {
    if (dupes.has(p.toLowerCase())) continue;
    dupes.add(p.toLowerCase());
    const stat = api.statFile(p);
    if (!stat) continue;
    items.push({
      id: ++uid, path: p,
      name: p.split(/[\\/]/).pop(),
      dir: p.replace(/[\\/][^\\/]+$/, ''),
      size: stat.size, status: 'pending', result: null,
    });
    added++;
  }
  if (pdfs.length && !added) showToast('所选文件已在列表中');
  render();
}

/* ---------- 渲染 ---------- */
function render() {
  // 拖拽区：列表非空时收起为紧凑态
  if (items.length > 0) {
    dropZone.classList.add('compact');
    levelPanel.classList.remove('hidden');
    outputPanel.classList.remove('hidden');
    summaryBar.classList.remove('hidden');
  } else {
    dropZone.classList.remove('compact');
    levelPanel.classList.add('hidden');
    outputPanel.classList.add('hidden');
    summaryBar.classList.add('hidden');
  }

  fileListEl.innerHTML = '';
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'file-card';

    // 状态芯片
    let statusHtml = '';
    if (item.status === 'pending') statusHtml = '<span class="status-chip pending">待压缩</span>';
    else if (item.status === 'working') statusHtml = '<span class="status-chip working"><span class="spinner"></span>压缩中…</span>';
    else if (item.status === 'done') statusHtml = '<span class="status-chip done">完成</span>';
    else if (item.status === 'skipped') statusHtml = '<span class="status-chip skipped">已是最佳体积</span>';
    else if (item.status === 'error') statusHtml = `<span class="status-chip error" title="${escapeAttr(item.error || '压缩失败')}">失败：${escapeHtml(short(item.error || '压缩失败'))}</span>`;

    // 体积对比
    let sizeHtml = `<div class="size-compare"><span class="size-before">${formatSize(item.size)}</span>`;
    if (item.result && !item.result.skipped) {
      const pct = (item.result.achieved * 100).toFixed(1);
      const targetPct = Math.round(item.result.target * 100);
      const dpiTip = item.result.res ? ` · ${item.result.res}dpi` : '';
      if (item.result.metTarget) {
        sizeHtml += `<span class="size-after green">${formatSize(item.result.newSize)}</span>
          <span class="saved-badge" title="目标 −${targetPct}%${dpiTip}">−${pct}%</span>`;
      } else {
        sizeHtml += `<span class="size-after">${formatSize(item.result.newSize)}</span>
          <span class="saved-badge partial" title="该文件可压缩空间有限，已达最小体积（目标 −${targetPct}%${dpiTip}）">−${pct}%</span>`;
      }
    } else if (item.status === 'skipped') {
      sizeHtml += `<span class="size-after">${formatSize(item.size)}</span>`;
    }
    sizeHtml += '</div>';

    // 打开文件夹按钮
    let openHtml = '';
    if (item.result && item.result.outputPath) {
      openHtml = `<button class="open-btn" data-open="${escapeAttr(item.result.outputPath)}">打开文件</button>`;
    }

    card.innerHTML = `
      <div class="file-info">
        <div class="file-name">${escapeHtml(item.name)}</div>
        <div class="file-path">${escapeHtml(item.dir)}</div>
      </div>
      <div class="row-actions">
        ${sizeHtml}
        ${statusHtml}
        ${openHtml}
        <button class="remove-btn" data-remove="${item.id}" title="移除">✕</button>
      </div>
    `;
    fileListEl.appendChild(card);
  }

  updateSummary();
}

function short(s) { return s.length > 28 ? s.slice(0, 28) + '…' : s; }
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s) { return escapeHtml(s); }

function updateSummary() {
  const doneItems = items.filter((i) => i.result && !i.result.skipped);
  const skipped = items.filter((i) => i.status === 'skipped');
  const before = doneItems.reduce((s, i) => s + i.result.originalSize, 0)
    + skipped.reduce((s, i) => s + i.size, 0);
  const after = doneItems.reduce((s, i) => s + i.result.newSize, 0)
    + skipped.reduce((s, i) => s + i.size, 0);
  const saved = before - after;

  const hasResult = items.some((i) => i.status === 'done' || i.status === 'skipped');
  if (!hasResult) {
    statBefore.textContent = formatSize(items.reduce((s, i) => s + i.size, 0));
    statAfter.textContent = '—';
    statSaved.textContent = '—';
  } else {
    statBefore.textContent = formatSize(before);
    statAfter.textContent = formatSize(after);
    statSaved.textContent = before > 0 ? `${formatSize(saved)}（${((saved / before) * 100).toFixed(1)}%）` : '—';
  }

  const anyPending = items.some((i) => i.status === 'pending');
  startBtn.disabled = !anyPending || isCompressing;
  startBtn.textContent = isCompressing ? '压缩中…' : '开始压缩';
  clearBtn.disabled = isCompressing;
}

/* ---------- 压缩 ---------- */
async function startCompress() {
  if (isCompressing) return;
  const queue = items.filter((i) => i.status === 'pending');
  if (!queue.length) return;
  if (outputMode === 'custom' && !customOutputDir) {
    showToast('请先选择输出文件夹');
    chooseFolder();
    return;
  }
  isCompressing = true;
  updateSummary();

  for (const item of queue) {
    item.status = 'working';
    render();
    try {
      const result = await api.compressFile({
        filePath: item.path,
        level: currentLevel,
        outputDir: outputMode === 'custom' ? customOutputDir : null,
      });
      if (result.ok) {
        if (result.skipped) {
          item.status = 'skipped';
        } else {
          item.status = 'done';
        }
        item.result = result;
      } else {
        item.status = 'error';
        item.error = result.error;
      }
    } catch (err) {
      item.status = 'error';
      item.error = String(err);
    }
    render();
  }

  isCompressing = false;
  const failed = items.filter((i) => i.status === 'error').length;
  if (failed) {
    showToast(`完成，${failed} 个文件失败`);
  } else if (outputMode === 'custom' && customOutputDir) {
    showToast(`全部压缩完成 ✓ 已输出到 ${customOutputDir}`);
  } else {
    showToast('全部压缩完成 ✓ 已输出到各文件旁的「压缩后」文件夹');
  }
  updateSummary();
}

/* ---------- 初始化输出位置状态 ---------- */
setOutputMode(outputMode);
if (customOutputDir) {
  customPathEl.textContent = customOutputDir;
  customPathEl.title = customOutputDir;
}

/* ---------- 事件绑定 ---------- */
dropZone.addEventListener('click', () => browseBtn.click());
browseBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  const paths = await api.selectFiles();
  if (paths.length) addFiles(paths);
});

['dragover', 'dragenter'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); })
);
['dragleave', 'drop'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); })
);
// 全窗口拖拽支持
['dragover', 'drop'].forEach((ev) =>
  window.addEventListener(ev, (e) => e.preventDefault())
);
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const paths = [...(e.dataTransfer.files || [])]
    .map((f) => api.getPathForFile(f))
    .filter(Boolean);
  if (paths.length) addFiles(paths);
  else showToast('请拖入 PDF 文件');
});

// 级别切换
document.getElementById('segmented').addEventListener('click', (e) => {
  const seg = e.target.closest('.seg');
  if (!seg || isCompressing) return;
  document.querySelectorAll('.seg').forEach((s) => s.classList.remove('active'));
  seg.classList.add('active');
  currentLevel = seg.dataset.level;
  // 级别变化后，重置已完成的结果，允许用新级别重新压缩
  if (items.some((i) => i.status === 'done' || i.status === 'skipped')) {
    items.forEach((i) => { if (i.status !== 'error') { i.status = 'pending'; i.result = null; } });
    render();
  }
});

startBtn.addEventListener('click', startCompress);

clearBtn.addEventListener('click', () => {
  if (isCompressing) return;
  items = [];
  render();
});

fileListEl.addEventListener('click', (e) => {
  const removeBtn = e.target.closest('[data-remove]');
  if (removeBtn && !isCompressing) {
    const id = Number(removeBtn.dataset.remove);
    items = items.filter((i) => i.id !== id);
    render();
    return;
  }
  const openBtn = e.target.closest('[data-open]');
  if (openBtn) {
    api.showInFolder(openBtn.dataset.open);
  }
});

// 无边框窗口控制
document.getElementById('tlClose').addEventListener('click', () => api.winClose());
document.getElementById('tlMin').addEventListener('click', () => api.winMinimize());
document.getElementById('tlMax').addEventListener('click', () => api.winMaximize());
