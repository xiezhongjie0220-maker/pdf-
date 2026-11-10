/**
 * PDF 压缩引擎：封装 Ghostscript + 按品质档位的自适应压缩
 * 纯 Node 模块，可脱离 Electron 单独测试
 *
 * v1.5.0 起改为「按品质压缩」方案（对齐 WPS 的三档品质模型）：
 * - 高品质：250dpi / 高质量 JPEG，压缩约 55%，适合打印与存档
 * - 中品质：175dpi / 中等质量 JPEG，压缩约 85%，屏幕阅读清晰（WPS 推荐档同水平）
 * - 低品质：120dpi / 较低质量 JPEG，压缩约 94%，体积最小、仍可读
 * 每档在「该档品质带内」按目标压缩率做阶梯搜索，达到目标即停，
 * 不会为了数字继续牺牲画质；达不到时按该档最激进参数输出。
 *
 * 关键机制（实测结论）：
 * - Ghostscript 默认 PassThroughJPEGImages=true，原 JPEG 会原样拷贝，
 *   所有质量参数都失效；重编码时必须关闭直通。
 * - 同分辨率重编码通常比原文件更大，所以体积主要靠降采样。
 * - 分辨率是体积的第一杠杆：300dpi→150dpi 面积降到 1/4。
 * - 黑白位图（扫描文字）按 400dpi 保留，文字始终锐利。
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/**
 * 三档品质：与 WPS「按品质压缩」对应
 * target = 预期压缩率（实测典型值）
 */
const LEVELS = {
  q_high: {
    target: 0.55,
    label: '高品质',
    tier: 'high',
    hint: '打印/存档 · 视觉几乎无差',
  },
  q_mid: {
    target: 0.85,
    label: '中品质',
    tier: 'mid',
    hint: '屏幕阅读清晰 · 推荐',
  },
  q_low: {
    target: 0.93,
    label: '低品质',
    tier: 'low',
    hint: '体积最小 · 可读',
  },
};

/** 黑白位图统一处理分辨率：位图文字 400dpi 依然锐利 */
const MONO_RES = 400;

/**
 * 每档的品质带阶梯：由「更保画质」到「该档最激进」排列，体积单调递减。
 * 搜索时从阶梯中选出「刚好达到目标压缩率」的最温和一档。
 * lossless = 纯结构优化（零画质损失），仅高品质档保留
 */
const LADDERS = {
  high: [
    { lossless: true },
    { res: 300, qf: 0.12 },
    { res: 290, qf: 0.15 },
    { res: 280, qf: 0.18 },
    { res: 270, qf: 0.21 },
    { res: 260, qf: 0.24 },
    { res: 250, qf: 0.27 },
    { res: 240, qf: 0.30 },
    { res: 230, qf: 0.33 },
    { res: 220, qf: 0.36 },
  ],
  mid: [
    { res: 200, qf: 0.34 },
    { res: 195, qf: 0.37 },
    { res: 190, qf: 0.40 },
    { res: 185, qf: 0.43 },
    { res: 180, qf: 0.45 },
    { res: 175, qf: 0.47 },
    { res: 170, qf: 0.49 },
    { res: 160, qf: 0.52 },
    { res: 150, qf: 0.56 },
  ],
  low: [
    { res: 145, qf: 0.60 },
    { res: 140, qf: 0.62 },
    { res: 135, qf: 0.65 },
    { res: 130, qf: 0.68 },
    { res: 125, qf: 0.70 },
    { res: 120, qf: 0.72 },
    { res: 115, qf: 0.75 },
    { res: 110, qf: 0.78 },
    { res: 105, qf: 0.81 },
    { res: 100, qf: 0.84 },
  ],
};

/** 兼容旧导出：默认阶梯 */
const LADDER = LADDERS.mid;

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
    // 图像重编码 + 降采样
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
      // 黑白位图（扫描文字）：保留 400dpi，文字始终锐利
      '-dDownsampleMonoImages=true',
      '-dMonoImageDownsampleType=/Subsample',
      `-dMonoImageResolution=${MONO_RES}`,
      '-dAutoFilterColorImages=false',
      '-dColorImageFilter=/DCTEncode',
      '-dAutoFilterGrayImages=false',
      '-dGrayImageFilter=/DCTEncode',
      // 图像里保留的文本可选内容（OCR 层）不丢
      '-dPreserveMarkedContent=true',
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
 * 按品质档位压缩。
 * cfg = LEVELS[key]，包含 target / tier
 * 返回 { ok, skipped, originalSize, newSize, achieved, metTarget, res, qf, lossless, gray, probes }
 */
async function compressToTarget(gsPath, inputPath, outputPath, cfg, tmpDir) {
  const originalSize = fs.statSync(inputPath).size;
  const target = cfg.target;
  const ladder = LADDERS[cfg.tier] || LADDERS.mid;
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

  // 二分：找到「第一个达到目标压缩率」的阶梯位置（体积随 index 单调递减）
  let lo = 0;
  let hi = ladder.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rec = await probeStep(ladder[mid]);
    if (!rec) {
      const alt = await probeStep(ladder[Math.min(ladder.length - 1, mid + 1)]);
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
      const idx = ladder.findIndex((s) => !s.lossless && s.res === best.res && s.qf === best.qf);
      const candidates = [];
      if (idx >= 0) candidates.push(probeStep({ ...ladder[idx], gray: true }));
      if (idx >= 0 && idx + 1 < ladder.length) candidates.push(probeStep({ ...ladder[idx + 1], gray: true }));
      const grayResults = (await Promise.all(candidates)).filter(Boolean);
      // 在「原方案 + 灰度方案」中选压缩率最接近目标的一档：
      // 灰度虽然视觉无差异，但过度压缩会白降分辨率，不如停在更温和的档位
      const pool = [best, ...grayResults];
      const better = pool.reduce((a, b) => {
        if (!a) return b;
        const da = Math.abs(a.reduction - target);
        const db = Math.abs(b.reduction - target);
        if (db < da - 0.005) return b;
        if (Math.abs(db - da) <= 0.005 && b.size < a.size) return b;
        return a;
      }, null);
      if (better) best = better;
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
    metTarget: best.reduction >= target - 0.03,
    res: best.res,
    qf: best.qf,
    lossless: best.lossless,
    gray: best.gray,
    probes,
  };
}

/**
 * 压缩前体积预估（对应 WPS「按品质压缩」里的「点击计算 / 预估体积」）。
 *
 * 用该档品质带的「代表参数」对整份文档做一次试压缩：
 * - 不做二分搜索、不做灰度优化，耗时约为正式压缩的 1/8
 * - 返回估算体积与压缩率，仅供选择档位时参考
 * - 试压缩产物立即删除，不写用户目录
 *
 * 代表参数的取点按档位经验位置选取：二分搜索在不同品质带里
 * 通常停在不同位置（高品质偏带尾、低品质偏带首），按此取点
 * 可让预估与最终结果的偏差落在几个百分点内。
 *
 * 这是自主实现的估算逻辑，不依赖、不调用 WPS 的任何组件。
 */
async function estimateCompression(gsPath, inputPath, cfg, tmpDir) {
  const originalSize = fs.statSync(inputPath).size;
  const ladder = LADDERS[cfg.tier] || LADDERS.mid;
  const positions = { high: 0.65, mid: 0.5, low: 0.35 };
  const pos = positions[cfg.tier] ?? 0.5;
  const step = ladder[Math.min(ladder.length - 1, Math.floor(ladder.length * pos))];
  const out = path.join(tmpDir, 'estimate.pdf');
  const r = await runGhostscript(gsPath, inputPath, out, step);
  try { fs.unlinkSync(out); } catch { /* 忽略 */ }
  if (!r.ok) return { ok: false, error: r.error };
  // 试压缩比原文件还大时按「已是最佳体积」返回
  const estimatedSize = Math.min(r.size, originalSize);
  return {
    ok: true,
    originalSize,
    estimatedSize,
    reduction: 1 - estimatedSize / originalSize,
    res: step.res || null,
  };
}

module.exports = {
  LEVELS, LADDERS, LADDER, MONO_RES,
  runGhostscript, compressToTarget, estimateCompression,
};
