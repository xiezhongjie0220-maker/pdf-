# WPS「按品质压缩」方案静态分析（REA 证据）

> 本文记录一次**只读静态分析**：用开源工具 [REA (Reverse Engineer Anything)](https://github.com/morluto/rea) 观察本机 WPS Office 的 PDF 压缩模块，理解其压缩策略，并据此改进本项目自己的开源实现。
>
> **合规边界**：分析仅涉及 PE 导入表、导出符号、字符串常量与资源清单等事实性信息，全程不执行、不调试、不修改 WPS 程序。本项目**没有复制 WPS 的任何代码、二进制、资源文件或界面素材**；所有压缩能力均由本地开源引擎 Ghostscript 自主实现，档位数值由本项目自行实验标定。分析目的是技术学习与技术互操作，不构成对 WPS 软件著作权的任何主张。

## 1. 分析环境

| 项 | 内容 |
| --- | --- |
| 分析工具 | REA 6.8.0（源码部署 + `npm install` + `npm run compile`），Node.js 24.22.1 |
| 分析目标 | WPS Office `12.1.0.28505` / `12.1.0.29161` 的 `office6` 目录 |
| 主要目标文件 | `pdfcore.dll`（PE32 x86，33.93 MB，SHA256 `e5c736009bf514eb…`）、`pdfmain.dll`、`qpdfpaint.dll`、`kso.dll`、`kbaseconfigcenter.dll`、`wpscore.dll` |
| REA 命令 | `inspect-pe-imports`、`inspect-native-exports`、`inspect-pe-resources`（均为纯静态、无需外部反汇编引擎） |
| 辅助手段 | 只读的 ASCII / UTF-16LE 字符串扫描，用于定位模块，不执行任何 WPS 代码 |

REA 部署与复现命令（路径换成你本机的 WPS 目录）：

```bash
# 部署 REA（Node 需满足 ^22.23.4 / ^24.22.1 / >=26.12.1）
npm install --registry=https://registry.npmmirror.com
npm run compile

# 只读静态检查
node scripts/rea.mjs inspect-pe-imports   "/path/to/office6/pdfcore.dll" --json
node scripts/rea.mjs inspect-native-exports "/path/to/office6/pdfmain.dll" --json
node scripts/rea.mjs inspect-pe-resources  "/path/to/office6/pdfmain.dll" --json
```

## 2. 关键证据

### 2.1 `pdfcore.dll` 导入表（REA `inspect-pe-imports`）

`architecture: x86`、`machine: 332`、25 个导入 DLL、`imphash: 867f424b81b77b2c8aea482506498aa6`。其中 `kso.dll` 提供了三个关键函数：

```
?setJpegQuality@KsoPDFGenerator@kpt@@UAEXH@Z    # 设置 JPEG 质量
?setCurPageDpi@KsoPDFGenerator@kpt@@UAEXH@Z    # 设置当前页 DPI
?setDocPageMode@KsoPDFGenerator@kpt@@UAEXH@Z   # 设置页面模式
```

### 2.2 PDF SDK 导出符号（`qpdfpaint.dll` / `kso.dll`）

```
QPDFSDK_Doc_SetJpegQuality          # JPEG 质量
QPDFSDK_Doc_SetLossLessImageCompress # 无损图像压缩开关
QPDFSDK_Doc_SetPageMode             # 页面模式
QPDFSDK_Page_DeviceDpi              # 设备 DPI
```

### 2.3 压缩功能入口与开关

| 模块 | 观察到的标识 | 含义 |
| --- | --- | --- |
| `kbaseconfigcenter*.dll` | `PDFCompressInTools`、`PDFCompressInHome`、`PdfCompressDetachedProcessToPhoto`、`PdfCompressPostAction` | 功能开关；**独立进程把 PDF 转成照片** |
| `pdfmain.dll` / `ufdmain.dll` | `SaveAsPDFCompressBridge`、`ExtendCommand_PdfCompress`、`Command_PdfCompress`、`Command_compressPdf2Photo`、`pdfbatchcompression` | 命令入口与批量压缩 |
| `pdfmain.dll` | `KxPdfCompressTask`、`sigCompressFinished`、`sigCompressSimulateFinished`、`sigCompressProgressUpdate` | 压缩任务、**模拟/预估体积**、进度通知 |
| `wpscore.dll` | `setCurPageDpi@KsoPDFGenerator` | 页面 DPI 设置的实现侧 |

### 2.4 界面档位（用户提供的 WPS 截图）

标题为「按品质压缩」，三档为 **高品质 / 中品质 / 低品质**；中品质显示 `4.21MB → 551.79KB ↓87%`，高品质显示「点击计算」，低品质显示「AI预估体积中…」。

## 3. 机制结论

1. **体积的两个杠杆是「图像分辨率」和「JPEG 质量」**。`setCurPageDpi` + `setJpegQuality` 是直接证据。300dpi 扫描件降到 150~180dpi，像素量只剩约 1/3，这是能做到 −87% 而屏幕阅读「无明显失真」的原因；单纯调 JPEG 质量做不到这个量级。
2. **存在一条整页光栅化路径**。`PdfCompressDetachedProcessToPhoto` / `Command_compressPdf2Photo` 表明 WPS 会起独立进程把页面转成照片再重新生成 PDF。
3. **压缩前先预估体积**。`sigCompressSimulateFinished` 对应界面上的「点击计算 / AI预估体积」，先给出「压缩前 → 压缩后 ↓%」再让用户选档。
4. **另有无损档**。`QPDFSDK_Doc_SetLossLessImageCompress` 说明存在零画质损失的结构/图像优化选项。
5. **档位的具体 DPI / 质量常量不在静态二进制的明文表里**，由运行时压缩任务与配置中心下发。因此本项目没有「抄参数」，而是用本地样本自行扫描标定（见 `compressor.js` 的 `LADDERS`）。

## 4. 与本项目实现的对照

| WPS 能力 | 本项目实现 | 位置 |
| --- | --- | --- |
| 高 / 中 / 低品质三档 | `q_high` / `q_mid` / `q_low`，目标 −55% / −85% / −93% | `compressor.js` `LEVELS` |
| DPI + JPEG 质量两个杠杆 | 每档独立的 `res × QFactor` 阶梯 + 二分搜索，取「刚好达标的最温和参数」 | `LADDERS` / `compressToTarget` |
| 无损图像压缩档 | `lossless` 首档（结构无损：字体子集化、重复对象去重、内容流压缩） | `runGhostscript` |
| 压缩前预估体积 | **v1.6.0 新增**：用档位代表参数做一次轻量试压缩，给出预计体积与压缩率 | `estimateCompression` / `estimate-file` IPC |
| 整页光栅化（转照片） | **有意识地不采用** | 见下节 |
| 文字保护 | 矢量文字原样保留；黑白位图固定 400dpi；灰度文档自动转灰度 | `MONO_RES` / `detectGrayscale` |

实测（本项目，5.98 MB / 300dpi 扫描件）：高品质 −56.8%、中品质 −84.8%、低品质 −93.1%。中品质与 WPS 界面所示的 −87% 处于同一水平，且肉眼对比文字清晰可读。

## 5. 为什么不完全照搬「转照片」

WPS 的 `compressPdf2Photo` 会把整页（含文字）变成位图。这样体积能压得更狠，但代价是：文字不再可选中/可搜索、放大后发虚、打印质量下降。本项目从 v1.3.0 起的核心目标是「**只改变文档大小，不改变文档内文字的清晰度**」，因此保留矢量文字、只对内嵌图像做双三次降采样与 JPEG 重编码，并对扫描文字位图保留 400dpi。这是基于产品目标的主动取舍，而不是能力缺失。

## 6. 结论

REA 的静态证据验证了 v1.5.0 的压缩方案与 WPS 同源思路（**降分辨率换体积、按品质分档**），并补上了此前缺少的一环：**压缩前预估体积**。v1.6.0 据此新增了本地预估功能，同时保持全部实现均为开源自主代码。
