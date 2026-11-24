#requires -Version 5.1
<#
  ChatDSH Windows 设备端完全卸载脚本（PowerShell 5.1 / PowerShell 7+ 通用）。
  彻底移除 @chatdsh/bundle 插件、pnpm-workspace.yaml overrides 与本地配对凭据，保留官方 DSH 本体与历史会话日志。

  远程免克隆执行：
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/uninstall.ps1))) -Device
#>
[CmdletBinding()]
param(
  [switch]$Device,
  [string[]]$Profile = @('web'),
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help -or -not $Device) {
  @'
用法（Windows PowerShell）：
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/uninstall.ps1))) -Device
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/uninstall.ps1))) -Device -Profile web,desktop

参数：
  -Device                移除设备端 @chatdsh/bundle 插件、overrides、设备凭据与缓存文件（保留官方 DSH 会话日志）
  -Profile <名称列表>    目标官方 DSH profile（默认 web，可用逗号传多个）
  -Help                  显示帮助信息
'@ | Write-Host
  if ($Help) { return } else { throw '请传入 -Device 参数执行设备端卸载，或使用 -Help 查看帮助。' }
}

function Resolve-DshBin {
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_BIN) -and (Test-Path -LiteralPath $env:DSH_BIN)) { return $env:DSH_BIN }
  foreach ($cand in @('dsh.cmd', 'dsh.exe', 'dsh.ps1', 'dsh')) {
    $cmd = Get-Command $cand -ErrorAction SilentlyContinue
    if ($null -ne $cmd) { return $cmd.Source }
  }
  return ''
}

function Invoke-TempNodeScript([string]$WorkDir, [string]$ScriptContent, [string[]]$ScriptArgs, [switch]$SuppressStderr) {
  if (-not (Test-Path -LiteralPath $WorkDir)) {
    New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
  }
  $tmpScript = Join-Path $WorkDir ".chatdsh-helper-$PID-$([Guid]::NewGuid().ToString('N').Substring(0, 8)).cjs"
  try {
    [System.IO.File]::WriteAllText($tmpScript, $ScriptContent, (New-Object System.Text.UTF8Encoding($false)))
    if ($SuppressStderr) {
      $out = & node $tmpScript @ScriptArgs 2>$null
    } else {
      $out = & node $tmpScript @ScriptArgs
    }
    return @{ ExitCode = $LASTEXITCODE; Output = $out }
  } finally {
    if (Test-Path -LiteralPath $tmpScript) {
      Remove-Item -LiteralPath $tmpScript -Force -ErrorAction SilentlyContinue
    }
  }
}

function Read-ProfileStoreDir([string]$ProfileDir, [string]$DshHome, [string]$DshBin) {
  if (-not [string]::IsNullOrWhiteSpace($env:pnpm_config_store_dir)) { return $env:pnpm_config_store_dir }
  if (-not [string]::IsNullOrWhiteSpace($env:npm_config_store_dir)) { return $env:npm_config_store_dir }
  if (-not [string]::IsNullOrWhiteSpace($env:CHATDSH_PNPM_STORE)) { return $env:CHATDSH_PNPM_STORE }
  $modulesYaml = Join-Path $ProfileDir 'node_modules\.modules.yaml'
  if (Test-Path -LiteralPath $modulesYaml) {
    $js = @'
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const modulesYaml = process.argv[2];
const dshBin = process.argv[3];
const candidates = [];
if (dshBin) {
  try {
    const realBin = fs.realpathSync(dshBin);
    candidates.push(path.resolve(path.dirname(realBin), "..", "package.json"));
    candidates.push(path.resolve(path.dirname(realBin), "node_modules", "@deepseek-ai", "dsh", "package.json"));
  } catch {}
}
for (const anchor of candidates) {
  if (!fs.existsSync(anchor)) continue;
  try {
    const YAML = createRequire(anchor)("yaml");
    const parsed = YAML.parse(fs.readFileSync(modulesYaml, "utf8"));
    if (parsed && typeof parsed.storeDir === "string" && parsed.storeDir.trim() !== "") {
      const raw = parsed.storeDir.trim();
      const base = path.basename(raw);
      console.log(/^v\d+$/.test(base) ? path.dirname(raw) : raw);
      process.exit(0);
    }
  } catch {}
}
'@
    $res = Invoke-TempNodeScript $DshHome $js @($modulesYaml, $DshBin) -SuppressStderr
    if ($res.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($res.Output)) {
      return ($res.Output | Select-Object -First 1).Trim()
    }
  }
  $fallback = Join-Path $DshHome 'chatdsh-pnpm-store'
  if (Test-Path -LiteralPath $fallback) { return $fallback }
  return ''
}

function Clean-WorkspaceOverrides([string]$WorkspaceFile, [string]$DshHome, [string]$DshBin) {
  if (-not (Test-Path -LiteralPath $WorkspaceFile)) { return }
  $js = @'
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const workspaceFile = process.argv[2];
const dshBin = process.argv[3];
const candidates = [];
if (dshBin) {
  try {
    const realBin = fs.realpathSync(dshBin);
    candidates.push(path.resolve(path.dirname(realBin), "..", "package.json"));
    candidates.push(path.resolve(path.dirname(realBin), "node_modules", "@deepseek-ai", "dsh", "package.json"));
  } catch {}
}
let YAML = null;
for (const anchor of candidates) {
  if (!fs.existsSync(anchor)) continue;
  try { YAML = createRequire(anchor)("yaml"); break; } catch {}
}
if (!YAML) throw new Error("未找到 yaml 解析库，无法安全清理 pnpm-workspace.yaml");
const text = fs.readFileSync(workspaceFile, "utf8");
if (text.trim() === "") process.exit(0);
const doc = YAML.parseDocument(text);
const overrides = doc.get("overrides");
if (overrides && typeof overrides === "object" && Array.isArray(overrides.items)) {
  let removed = 0;
  for (const pair of [...overrides.items]) {
    const key = String(pair.key && pair.key.value !== undefined ? pair.key.value : pair.key);
    if (key.startsWith("@chatdsh/")) {
      doc.deleteIn(["overrides", key]);
      removed += 1;
    }
  }
  const remaining = doc.get("overrides");
  if (remaining && Array.isArray(remaining.items) && remaining.items.length === 0) doc.delete("overrides");
  if (removed > 0) {
    fs.writeFileSync(workspaceFile, String(doc), "utf8");
    console.log("已从 " + workspaceFile + " 清理 " + removed + " 条 @chatdsh/* overrides 登记。");
  }
}
'@
  $res = Invoke-TempNodeScript $DshHome $js @($WorkspaceFile, $DshBin)
  if ($res.Output) { $res.Output | ForEach-Object { Write-Host $_ } }
  if ($res.ExitCode -ne 0) { throw "清理 $WorkspaceFile 失败" }
}

function Clean-ProfilePackageJson([string]$PkgFile, [string]$DshHome) {
  if (-not (Test-Path -LiteralPath $PkgFile)) { return }
  $js = @'
const fs = require("node:fs");
const pkgFile = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
let changed = false;
for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
  if (pkg[section] && typeof pkg[section] === "object") {
    for (const key of Object.keys(pkg[section])) {
      if (key.startsWith("@chatdsh/")) { delete pkg[section][key]; changed = true; }
    }
  }
}
if (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) {
  const next = pkg.dsh.profile.bundles.filter((b) => typeof b !== "string" || !b.startsWith("@chatdsh/"));
  if (next.length !== pkg.dsh.profile.bundles.length) { pkg.dsh.profile.bundles = next; changed = true; }
}
if (changed) {
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  console.log("已从 " + pkgFile + " 清理残留的 @chatdsh/* 声明。");
}
'@
  $res = Invoke-TempNodeScript $DshHome $js @($PkgFile)
  if ($res.Output) { $res.Output | ForEach-Object { Write-Host $_ } }
}

$DshHome = if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $env:DSH_HOME.Trim() } else { Join-Path $env:USERPROFILE '.dsh' }
$DshBin = Resolve-DshBin

Write-Host '=== 开始清理 Windows 设备端 ChatDSH 插件与本地凭据 ==='
foreach ($p in $Profile) {
  $profileDir = Join-Path $DshHome "profiles\$p"
  if (-not (Test-Path -LiteralPath $profileDir)) {
    Write-Host "跳过不存在的 profile：$p（$profileDir）"
    continue
  }
  $storeDir = Read-ProfileStoreDir $profileDir $DshHome $DshBin
  $pkgFile = Join-Path $profileDir 'package.json'
  if (-not [string]::IsNullOrEmpty($DshBin) -and (Test-Path -LiteralPath $pkgFile) -and (Select-String -LiteralPath $pkgFile -Pattern '"@chatdsh/bundle"' -SimpleMatch -Quiet)) {
    Write-Host "正在从官方 $p profile 卸载 @chatdsh/bundle..."
    $prevHome = $env:DSH_HOME; $prevNpm = $env:npm_config_store_dir; $prevPnpm = $env:pnpm_config_store_dir
    try {
      $env:DSH_HOME = $DshHome
      if (-not [string]::IsNullOrEmpty($storeDir)) {
        $env:npm_config_store_dir = $storeDir
        $env:pnpm_config_store_dir = $storeDir
      }
      & $DshBin plugin --profile $p remove '@chatdsh/bundle'
    } finally {
      $env:DSH_HOME = $prevHome; $env:npm_config_store_dir = $prevNpm; $env:pnpm_config_store_dir = $prevPnpm
    }
  }
  Clean-ProfilePackageJson $pkgFile $DshHome
  Clean-WorkspaceOverrides (Join-Path $profileDir 'pnpm-workspace.yaml') $DshHome $DshBin
  $scopeDir = Join-Path $profileDir 'node_modules\@chatdsh'
  if (Test-Path -LiteralPath $scopeDir) { Remove-Item -LiteralPath $scopeDir -Recurse -Force }
  $pnpmDir = Join-Path $profileDir 'node_modules\.pnpm'
  if (Test-Path -LiteralPath $pnpmDir) {
    Get-ChildItem -LiteralPath $pnpmDir -Filter '@chatdsh+*' -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
  }
  if (-not [string]::IsNullOrEmpty($DshBin)) {
    $prevHome = $env:DSH_HOME
    try {
      $env:DSH_HOME = $DshHome
      & $DshBin --profile $p --dump-config | Out-Null
      if ($LASTEXITCODE -eq 0) { Write-Host "已校验官方 $p profile 配置可正常加载（未受损）。" }
    } finally {
      $env:DSH_HOME = $prevHome
    }
  }
}

$targets = @(
  (Join-Path $DshHome 'chatdsh-device.env'),
  (Join-Path $DshHome 'chatdsh-device-join.ps1'),
  (Join-Path $DshHome 'chatdsh-tarballs'),
  (Join-Path $DshHome 'chatdsh-download'),
  (Join-Path $DshHome 'chatdsh-pnpm-store'),
  (Join-Path $DshHome 'push\replica-intents.sqlite'),
  (Join-Path $DshHome 'push\replica-intents.sqlite-wal'),
  (Join-Path $DshHome 'push\replica-intents.sqlite-shm')
)
foreach ($item in $targets) {
  if (Test-Path -LiteralPath $item) {
    Remove-Item -LiteralPath $item -Recurse -Force
    Write-Host "已删除：$item"
  }
}
$pushDir = Join-Path $DshHome 'push'
if ((Test-Path -LiteralPath $pushDir) -and ((Get-ChildItem -LiteralPath $pushDir -Force | Measure-Object).Count -eq 0)) {
  Remove-Item -LiteralPath $pushDir -Force
}

Write-Host 'Windows 设备端 ChatDSH 插件与凭据已清理完成（官方 DSH 会话日志与原生配置保持不变）。'
