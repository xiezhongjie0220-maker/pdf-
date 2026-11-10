/**
 * PDF 压缩引擎：封装 Ghostscript + 目标压缩率搜索
 * 纯 Node 模块，可脱离 Electron 单独测试
 *
 * v1.3.0 起执行「文字清晰度优先」策略：
 * - 分辨率下限 200dpi：任何档位都不会把文字压到 200dpi 以下
 * - QFactor 上限 0.4：JPEG 重编码始终保持在视觉高质量区间
 * - 黑白位图（扫描文字）固定按 400dpi 处理，仅在高分辨率时轻降
 * - 首档为「结构无损」：完全不碰图像，只做字体子集化、重复对象
 *   去重、内容流压缩等纯无损优化
 * - 达不到目标压缩率时按「能压多少压多少」返回，绝不硬压
 *
 * 关键机制（实测结论）：
 * - Ghostscript 默认 PassThroughJPEGImages=true，原 JPEG 会原样拷贝，
 *   所有质量参数都失效；重编码时必须关闭直通。
 * - 同分辨率重编码通常比原文件更大，所以体积主要靠降采样，但要
 *   服从清晰度约束。
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/**
 * 三档压缩级别：按目标压缩率定义
 */
const LEVELS = {
  p20: { target: 0.20, label: '压缩 20%', hint: '画质优先' },
  p50: { target: 0.50, label: '压缩 50%', hint: '文字保清晰' },
  p70: { target: 0.70, label: '压缩 70%', hint: '文字保清晰' },
};

/** 分辨率下限：低于该值文字开始明显发虚，任何档位不得低于此 */
const MIN_RES = 200;
/** QFactor 上限（越大质量越低），超过该值文字会出现可见 JPEG 痕迹 */
const MAX_QF = 0.4;
/** 黑白位图统一处理分辨率：位图文字 400dpi 依然锐利 */
const MONO_RES = 400;

/**
 * 压缩阶梯：由「最温和」到「最激进」排列，体积单调递减。
 * lossless = 纯结构优化，不碰任何图像（零画质损失）
 * res  = 彩色/灰度图像重采样 dpi（不低于 MIN_RES）
 * qf   = Distiller QFactor（不超过 MAX_QF）
 */
const LADDER = [
  { lossless: true },
  { res: 300, qf: 0.15 },
  { res: 280, qf: 0.20 },
  { res: 260, qf: 0.25 },
  { res: 240, qf: 0.25 },
  { res: 225, qf: 0.30 },
  { res: 210, qf: 0.35 },
  { res: MIN_RES, qf: MAX_QF },
];

/** 用指定参数压一次 */
function runGhostscript(gsPath, inputPath, outputPath, step) {
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
  ];

  let extra = [];
  if (!step.lossless) {
    // 图像重编码 + 降采样（清晰度约束内的温和参数）
    extra = [
      // 关闭 JPEG 直通，否则质量参数不生效
      '-dPassThroughJPEGImages=false',
      // 彩色 / 灰度图像降采样（阈值 1.0 = 超过目标分辨率即降）
      '-dDownsampleColorImages=true',
      '-dColorImageDownsampleType=/Bicubic',
      '-dColorImageDownsampleThreshold=1.0',
      `-dColorImageResolution=${step.res}`,
      '-dDownsampleGrayImages=true',
      '-dGrayImageDownsampleType=/Bicubic',
      '-dGrayImageDownsampleThreshold=1.0',
      `-dGrayImageResolution=${step.res}`,
      // 黑白位图（扫描文字）：只在高于 400dpi 时轻降，保证文字锐度
      '-dDownsampleMonoImages=true',
      '-dMonoImageDownsampleType=/Subsample',
      `-dMonoImageResolution=${MONO_RES}`,
      '-dAutoFilterColorImages=false',
      '-dColorImageFilter=/DCTEncode',
      '-dAutoFilterGrayImages=false',
      '-dGrayImageFilter=/DCTEncode',
    ];
    // 灰度文档（如黑白扫描件）：RGB→灰度存储，视觉零差异、体积大幅缩小
    if (step.gray) {
      extra.push('-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray');
    }
    extra.push(
      '-c',
      `<< /ColorImageDict <</QFactor ${step.qf.toFixed(2)} /Blend 1 /HSamples [1 1 1 1] /VSamples [1 1 1 1]>> ` +
        `/GrayImageDict <</QFactor ${step.qf.toFixed(2)} /Blend 1 /HSamples [1 1 1 1] /VSamples [1 1 1 1]>> >> setdistillerparams`,
    );
  }

  // 参数顺序敏感：-f 之后的参数都会被当作文件名，-c 之后会当作 PostScript，
  // 因此固定顺序 = 基础参数 → 输出文件 → (-c 质量参数) → -f 输入文件
  const all = [...args, `-sOutputFile=${outputPath}`, ...extra, '-f', inputPath];

  return new Promise((resolve) => {
    const proc = spawn(gsPath, all, { windowsHide: true });
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
 * 检测文档是否「实际为灰度内容」（如黑字白底的扫描件）。
 * 用极低分辨率渲染全部页面并统计像素色度，只有几乎所有像素
 * 都无彩色时才返回 true——此时 RGB→灰度存储视觉零差异。
 */
function detectGrayscale(gsPath, inputPath, tmpDir) {
  return new Promise((resolve) => {
    const prefix = path.join(tmpDir, 'gsdet-');
    const args = ['-sDEVICE=ppmraw', '-r24', '-dNOPAUSE', '-dBATCH', '-dQUIET',
      `-sOutputFile=${prefix}%03d.ppm`, '-f', inputPath];
    const proc = spawn(gsPath, args, { windowsHide: true });
    proc.on('error', () => resolve(false));
    proc.on('close', () => {
      try {
        const files = fs.readdirSync(tmpDir)
          .filter((f) => f.startsWith('gsdet-') && f.endsWith('.ppm'));
        if (!files.length) return resolve(false);
        let checked = 0;
        let colorful = 0;
        for (const f of files) {
          const buf = fs.readFileSync(path.join(tmpDir, f));
          // 解析 P6 头部：P6 / 宽 / 高 / 最大值（跳过空白与 # 注释）
          const tokens = [];
          let idx = 2; // 跳过 "P6"
          while (tokens.length < 3 && idx < buf.length) {
            while (idx < buf.length && /\s/.test(String.fromCharCode(buf[idx]))) idx++;
            if (idx < buf.length && buf[idx] === 35) { // '#'
              while (idx < buf.length && buf[idx] !== 10) idx++;
              continue;
            }
            let start = idx;
            while (idx < buf.length && !/\s/.test(String.fromCharCode(buf[idx]))) idx++;
            tokens.push(String.fromCharCode(...buf.slice(start, idx)));
            idx++;
          }
          const w = parseInt(tokens[0], 10);
          const h = parseInt(tokens[1], 10);
          if (!w || !h) continue;
          const px = buf.subarray(idx, idx + w * h * 3);
          for (let p = 0; p + 2 < px.length; p += 3) {
            checked++;
            const r = px[p], g = px[p + 1], b = px[p + 2];
            if (Math.max(r, g, b) - Math.min(r, g, b) > 24) colorful++;
          }
        }
        resolve(checked > 0 && colorful / checked < 0.004);
      } catch {
        resolve(false);
      }
    });
  });
}

/**
 * 压缩到目标压缩率（在清晰度约束内搜索）。
 * 返回 { ok, skipped, originalSize, newSize, achieved, metTarget, res, lossless, gray }
 */
async function compressToTarget(gsPath, inputPath, outputPath, cfg, tmpDir) {
  const originalSize = fs.statSync(inputPath).size;
  const target = cfg.target;
  const cache = new Map(); // key -> { path, size, reduction, res, qf, lossless, gray }
  let probes = 0;

  const probeStep = async (step) => {
    const key = step.lossless ? 'lossless' : `${step.gray ? 'g' : 'c'}${step.res}-${step.qf}`;
    if (cache.has(key)) return cache.get(key);
    const out = path.join(tmpDir, `try-${probes}.pdf`);
    const r = await runGhostscript(gsPath, inputPath, out, step);
    probes++;
    if (!r.ok) return null;
    const rec = {
      path: out, size: r.size, res: step.res || null, qf: step.qf || null,
      lossless: !!step.lossless, gray: !!step.gray,
      reduction: 1 - r.size / originalSize,
    };
    cache.set(key, rec);
    return rec;
  };

  const probeIndex = async (idx) => probeStep(LADDER[idx]);

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
      if (dA < dB - 0.004) best = rec;
      // 同样接近时优先无损方案 / 更高分辨率（画质更好）
      else if (Math.abs(dA - dB) <= 0.004 && (rec.lossless || (rec.res || 0) > (best.res || 0))) best = rec;
    }
    return best;
  };

  let best = pickBest();

  // 灰度文档优化：若整份文档实际为灰度内容（如黑字白底扫描件），
  // 对最优档及其相邻更激进档尝试灰度存储——视觉零差异、体积更小
  if (best && !best.lossless && best.res) {
    const isGrayDoc = await detectGrayscale(gsPath, inputPath, tmpDir);
    if (isGrayDoc) {
      const idx = LADDER.findIndex(
        (s) => !s.lossless && s.res === best.res && s.qf === best.qf
      );
      const candidates = [probeStep({ ...LADDER[idx], gray: true })];
      if (idx + 1 < LADDER.length) {
        candidates.push(probeStep({ ...LADDER[idx + 1], gray: true }));
      }
      const grayResults = (await Promise.all(candidates)).filter(Boolean);
      const grayBest = grayResults.length
        ? grayResults.reduce((a, b) => (b.size < a.size ? b : a))
        : null;
      if (grayBest && grayBest.size < best.size) best = grayBest;
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
    lossless: best.lossless,
    probes,
  };
}

module.exports = { LEVELS, LADDER, MIN_RES, MAX_QF, MONO_RES, runGhostscript, compressToTarget };
