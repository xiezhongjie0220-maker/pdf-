/**
 * PDF 压缩引擎：封装 Ghostscript + 目标压缩率搜索
 * 纯 Node 模块，可脱离 Electron 单独测试
 *
 * 关键机制（实测结论）：
 * - Ghostscript 默认 PassThroughJPEGImages=true，原 JPEG 会原样拷贝，
 *   所有质量参数都失效；必须关闭直通才能真正重编码。
 * - 同分辨率重编码通常比原文件更大，所以真正决定体积的是「降采样分辨率」。
 * - 分辨率与体积不是线性关系：原图 200dpi 降到 190dpi 前几乎不变，
 *   一旦低于阈值就开始断崖式下降。因此用校准好的阶梯 + 二分搜索，
 *   而不是固定档位，才能比较准确地命中 20% / 50% / 70% 目标。
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/**
 * 三档压缩级别：按目标压缩率定义
 */
const LEVELS = {
  p20: { target: 0.20, label: '压缩 20%', hint: '画质优先' },
  p50: { target: 0.50, label: '压缩 50%', hint: '均衡推荐' },
  p70: { target: 0.70, label: '压缩 70%', hint: '体积优先' },
};

/**
 * 压缩阶梯：由「最温和」到「最激进」排列，实测体积单调递减。
 * res  = 彩色/灰度图像重采样 dpi（决定画质与体积）
 * qf   = Distiller QFactor（越小画质越高、体积越大）
 */
const LADDER = [
  { res: 300, qf: 0.35 },
  { res: 240, qf: 0.35 },
  { res: 200, qf: 0.30 },
  { res: 180, qf: 0.55 },
  { res: 165, qf: 0.60 },
  { res: 150, qf: 0.60 },
  { res: 135, qf: 0.55 },
  { res: 122, qf: 0.45 },
  { res: 110, qf: 0.55 },
  { res: 98, qf: 0.50 },
  { res: 86, qf: 0.55 },
  { res: 74, qf: 0.62 },
];

/** 用指定参数压一次 */
function runGhostscript(gsPath, inputPath, outputPath, { res, qf }) {
  const mono = Math.min(400, Math.max(180, Math.round(res * 1.8)));
  const ps =
    `<< /ColorImageDict <</QFactor ${qf.toFixed(2)} /Blend 1 ` +
    `/HSamples [1 1 1 1] /VSamples [1 1 1 1]>> ` +
    `/GrayImageDict <</QFactor ${qf.toFixed(2)} /Blend 1 ` +
    `/HSamples [1 1 1 1] /VSamples [1 1 1 1]>> >> setdistillerparams`;

  const args = [
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.6',
    '-dNOPAUSE',
    '-dBATCH',
    '-dQUIET',
    '-dCompressFonts=true',
    '-dSubsetFonts=true',
    '-dDetectDuplicateImages=true',
    '-dCompressPages=true',
    // 关闭 JPEG 直通，否则质量参数不生效
    '-dPassThroughJPEGImages=false',
    // 彩色 / 灰度图像降采样（阈值 1.0 = 超过目标分辨率即降）
    '-dDownsampleColorImages=true',
    '-dColorImageDownsampleType=/Bicubic',
    '-dColorImageDownsampleThreshold=1.0',
    `-dColorImageResolution=${res}`,
    '-dDownsampleGrayImages=true',
    '-dGrayImageDownsampleType=/Bicubic',
    '-dGrayImageDownsampleThreshold=1.0',
    `-dGrayImageResolution=${res}`,
    // 黑白位图（扫描文字）单独处理，保文字锐度
    '-dDownsampleMonoImages=true',
    '-dMonoImageDownsampleType=/Subsample',
    `-dMonoImageResolution=${mono}`,
    '-dAutoFilterColorImages=false',
    '-dColorImageFilter=/DCTEncode',
    '-dAutoFilterGrayImages=false',
    '-dGrayImageFilter=/DCTEncode',
    `-sOutputFile=${outputPath}`,
    '-c', ps,
    '-f', inputPath,
  ];

  return new Promise((resolve) => {
    const proc = spawn(gsPath, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => resolve({ ok: false, error: `无法启动压缩引擎: ${err.message}` }));
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve({ ok: true, size: fs.statSync(outputPath).size });
      } else {
        resolve({ ok: false, error: stderr.trim() || `压缩引擎退出码 ${code}` });
      }
    });
  });
}

/**
 * 压缩到目标压缩率（二分搜索压缩阶梯）。
 * 返回 { ok, skipped, originalSize, newSize, achieved, metTarget, res }
 */
async function compressToTarget(gsPath, inputPath, outputPath, cfg, tmpDir) {
  const originalSize = fs.statSync(inputPath).size;
  const target = cfg.target;
  const cache = new Map(); // key -> { path, size, reduction, res, qf }
  let probes = 0;

  const probeStep = async (step) => {
    const key = `${step.res}-${step.qf}`;
    if (cache.has(key)) return cache.get(key);
    const out = path.join(tmpDir, `try-${probes}.pdf`);
    const r = await runGhostscript(gsPath, inputPath, out, step);
    probes++;
    if (!r.ok) return null;
    const rec = {
      path: out, size: r.size, res: step.res, qf: step.qf,
      reduction: 1 - r.size / originalSize,
    };
    cache.set(key, rec);
    return rec;
  };

  const probeIndex = (idx) => probeStep(LADDER[idx]);

  // 二分：找到「第一个达到目标压缩率」的阶梯位置（体积随 index 单调递减）
  let lo = 0;
  let hi = LADDER.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rec = await probeIndex(mid);
    if (!rec) {
      // 单次失败时向更激进的相邻项回退一次
      const alt = await probeIndex(Math.min(LADDER.length - 1, mid + 1));
      if (!alt) break;
      lo = mid + 2;
      continue;
    }
    if (rec.reduction >= target) {
      hi = mid - 1;   // 已达标，尝试更温和的参数（保画质）
    } else {
      lo = mid + 1;   // 未达标，需要更激进
    }
  }

  if (!cache.size) return { ok: false, error: '压缩失败' };

  const pickBest = () => {
    let best = null;
    for (const rec of cache.values()) {
      if (!best) { best = rec; continue; }
      const dA = Math.abs(rec.reduction - target);
      const dB = Math.abs(best.reduction - target);
      if (dA < dB - 0.004 || (Math.abs(dA - dB) <= 0.004 && rec.res > best.res)) best = rec;
    }
    return best;
  };

  let best = pickBest();

  // 微调：偏差超过 4 个百分点时，在当前分辨率上调整质量参数再试一次
  if (best && Math.abs(best.reduction - target) > 0.04 && best.size < originalSize) {
    const dir = best.reduction > target ? -1 : 1;   // 压过头 → 提质；没压够 → 降质
    const adj = {
      res: best.res,
      qf: Math.min(0.95, Math.max(0.06, +(best.qf + dir * 0.18).toFixed(2))),
    };
    if (!cache.has(`${adj.res}-${adj.qf}`)) {
      await probeStep(adj);
      best = pickBest();
    }
  }

  if (!best || best.size >= originalSize) {
    for (const rec of cache.values()) { try { fs.unlinkSync(rec.path); } catch { /* 忽略 */ } }
    return {
      ok: true, skipped: true, originalSize, newSize: originalSize,
      achieved: 0, metTarget: false, res: null, probes,
    };
  }

  fs.copyFileSync(best.path, outputPath);
  for (const rec of cache.values()) { try { fs.unlinkSync(rec.path); } catch { /* 忽略 */ } }

  return {
    ok: true,
    skipped: false,
    originalSize,
    newSize: best.size,
    achieved: best.reduction,
    metTarget: best.reduction >= target - 0.02,
    res: best.res,
    qf: best.qf,
    probes,
  };
}

module.exports = { LEVELS, LADDER, runGhostscript, compressToTarget };
