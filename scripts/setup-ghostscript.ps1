# 下载并解包 Windows 版 Ghostscript 到 resources/ghostscript
# 用法: powershell -ExecutionPolicy Bypass -File scripts/setup-ghostscript.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root 'resources\ghostscript'
$zipPath = Join-Path $env:TEMP 'gs-setup.exe'

if (Test-Path (Join-Path $dest 'bin\gswin64c.exe')) {
    Write-Host "Ghostscript 已存在，跳过下载。如需重装请先删除 $dest"
    exit 0
}

$version = '10.08.0'
$url = "https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs10080/gs10080w64.exe"
Write-Host "下载 Ghostscript $version ..."
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing

Write-Host "解包到 $dest ..."
$extractTmp = Join-Path $env:TEMP 'gs-extract'
if (Test-Path $extractTmp) { Remove-Item $extractTmp -Recurse -Force }

# 优先使用系统 7-Zip；否则回退到 npm 的 7zip-bin
$sevenZip = 'C:\Program Files\7-Zip\7z.exe'
if (-not (Test-Path $sevenZip)) {
    $sevenZip = Join-Path $root 'node_modules\7zip-bin\win\x64\7za.exe'
}
if (-not (Test-Path $sevenZip)) {
    Write-Error '未找到 7-Zip，请先安装 7-Zip 或执行 npm install'
}

& $sevenZip x -y $zipPath "-o$extractTmp" | Out-Null

New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $extractTmp 'bin') (Join-Path $dest 'bin') -Recurse -Force
Copy-Item (Join-Path $extractTmp 'lib') (Join-Path $dest 'lib') -Recurse -Force
Copy-Item (Join-Path $extractTmp 'iccprofiles') (Join-Path $dest 'iccprofiles') -Recurse -Force
Remove-Item $extractTmp -Recurse -Force
Remove-Item $zipPath -Force

Write-Host "完成 ✓  引擎位置: $dest\bin\gswin64c.exe"
