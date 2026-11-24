#requires -Version 5.1
<#
  ChatDSH Windows 设备侧一行接入脚本（PowerShell 5.1 / PowerShell 7+ 通用）。

  免克隆仓库一键接入（自动从 GitHub Releases 下载预构建插件归档并校验 SHA-256）：
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/device-join.ps1))) -Relay https://relay.example.com

  后续在同一设备再次启动（自动复用已安装插件与设备凭据）：
    powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\chatdsh-device-join.ps1"
#>
[CmdletBinding()]
param(
  [string]$Relay = '',
  [string]$PairUrl = '',
  [string]$Code = '',
  [string]$Profile = 'web',
  [string]$Name = '',
  [string]$Port = '',
  [string]$Bundle = '',
  [string]$BundleArchive = '',
  [string]$ReleaseTag = '',
  [int]$ApprovalTimeout = 600,
  [switch]$Remote,
  [switch]$FromLocal,
  [switch]$SkipChecksum,
  [switch]$InstallOnly,
  [switch]$CheckUpdate,
  [switch]$SkipInstall,
  [switch]$RePair,
  [switch]$NoStart,
  [switch]$RedactSecrets,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

$DefaultRepoUrl = 'https://github.com/wenzetan/chatdsh'
$GithubRepo = if ($env:CHATDSH_GITHUB_REPO) { $env:CHATDSH_GITHUB_REPO } else { ([Uri]$DefaultRepoUrl).AbsolutePath.Trim('/') }
$GithubRef = if ($env:CHATDSH_GITHUB_REF) { $env:CHATDSH_GITHUB_REF } else { 'main' }
$RawBase = if ($env:CHATDSH_RAW_BASE) { $env:CHATDSH_RAW_BASE.TrimEnd('/') } else { "https://raw.githubusercontent.com/$GithubRepo/$GithubRef" }
if ([string]::IsNullOrWhiteSpace($ReleaseTag)) {
  $ReleaseTag = if ($env:CHATDSH_RELEASE_TAG) { $env:CHATDSH_RELEASE_TAG } else { 'latest' }
}
$BundleArchiveName = if ($env:CHATDSH_BUNDLE_ARCHIVE_NAME) { $env:CHATDSH_BUNDLE_ARCHIVE_NAME } else { 'chatdsh-plugin-bundle.tar.gz' }
if ($env:CHATDSH_REDACT_SECRETS -eq '1') {
  $RedactSecrets = $true
}

function Show-Help {
  @'
用法（Windows PowerShell）：
  远程一键接入：& ([scriptblock]::Create((irm https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/device-join.ps1))) -Relay https://relay.example.com
  本地复用启动：powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\chatdsh-device-join.ps1"

参数：
  -Relay <域名或 origin>     中继对外地址（首次接入必填，后续自动复用）
  -Code <配对口令>           中继配对口令（不传时静默提示输入，不回显、不留历史）
  -Profile <名称>            目标官方 DSH profile（默认 web）
  -Name <设备名>             向中继登记的设备名称（默认当前主机名）
  -Port <端口>               传递给 dsh 的本地监听端口
  -Bundle <包名或路径>       直接传给 `dsh plugin add` 的自定义组合包来源
  -BundleArchive <路径/URL>  指定预构建插件归档 chatdsh-plugin-bundle.tar.gz 的本地路径或下载地址
  -ReleaseTag <标签>         指定 GitHub Release 标签（默认 latest）
  -ApprovalTimeout <秒>      等待中继管理员审批的超时秒数（默认 600）
  -PairUrl <origin>          配对请求使用的直连地址（默认与 -Relay 相同）
  -CheckUpdate               只读检查本机已安装插件归档与 GitHub Releases 是否有版本更新
  -InstallOnly               仅完成插件安装后退出（不配对、不启动 dsh）
  -SkipInstall               跳过插件安装步骤
  -SkipChecksum              跳过插件归档 SHA-256 校验（仅调试使用）
  -RePair                    忽略已保存凭据并重新配对
  -NoStart                   完成安装与配对后退出，不启动 dsh
  -RedactSecrets             脱敏输出模式：不向终端打印真实域名与凭据详情
  -Help                      显示帮助信息
'@ | Write-Host
}

if ($Help) {
  Show-Help
  return
}

function Normalize-PublicUrl([string]$Raw) {
  $trimmed = if ($null -eq $Raw) { '' } else { $Raw.Trim() }
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    throw '中继地址不能为空'
  }
  if ($trimmed -match '\s') {
    throw '中继地址不能包含空白字符'
  }
  $candidate = if ($trimmed -match '^[A-Za-z][A-Za-z0-9+.-]*://') { $trimmed } else { "https://$trimmed" }
  $uri = [Uri]$candidate
  if ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https') {
    throw "仅支持 http 或 https 协议：$($uri.Scheme)"
  }
  if (-not [string]::IsNullOrEmpty($uri.UserInfo) -or -not [string]::IsNullOrEmpty($uri.Query) -or -not [string]::IsNullOrEmpty($uri.Fragment)) {
    throw "中继地址必须是精确 HTTP/HTTPS origin：$Raw"
  }
  $pathPart = $uri.AbsolutePath.TrimEnd('/')
  if (-not [string]::IsNullOrEmpty($pathPart)) {
    throw "中继地址必须是精确 HTTP/HTTPS origin，不能包含路径：$Raw"
  }
  $defaultPort = ($uri.Scheme -eq 'https' -and $uri.Port -eq 443) -or ($uri.Scheme -eq 'http' -and $uri.Port -eq 80)
  if ($defaultPort) {
    return "$($uri.Scheme)://$($uri.Host.ToLowerInvariant())"
  }
  return "$($uri.Scheme)://$($uri.Host.ToLowerInvariant()):$($uri.Port)"
}

function Resolve-ReleaseBase([string]$Tag) {
  if (-not [string]::IsNullOrWhiteSpace($env:CHATDSH_RELEASE_BASE)) {
    return $env:CHATDSH_RELEASE_BASE.TrimEnd('/')
  }
  if ($Tag -eq 'latest') {
    return "https://github.com/$GithubRepo/releases/latest/download"
  }
  return "https://github.com/$GithubRepo/releases/download/$Tag"
}

function Resolve-DshBin {
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_BIN) -and (Test-Path -LiteralPath $env:DSH_BIN)) {
    return $env:DSH_BIN
  }
  foreach ($cand in @('dsh.cmd', 'dsh.exe', 'dsh.ps1', 'dsh')) {
    $cmd = Get-Command $cand -ErrorAction SilentlyContinue
    if ($null -ne $cmd) {
      return $cmd.Source
    }
  }
  throw '未找到 dsh 命令，请先安装官方 DSH（npm install -g @deepseek-ai/dsh）并确认已加入 PATH'
}

function Read-EnvMap([string]$Path) {
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
    if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      $key = $Matches[1]
      $val = $Matches[2].Trim()
      if (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'"))) {
        if ($val.Length -ge 2) { $val = $val.Substring(1, $val.Length - 2) }
      }
      $map[$key] = $val
    }
  }
  return $map
}

function Format-EnvValue([string]$Value) {
  if ([string]::IsNullOrEmpty($Value)) { return '' }
  if ($Value -match '^[A-Za-z0-9_./:@+-]+$') { return $Value }
  $escaped = $Value.Replace('\', '\\').Replace('"', '\"')
  return "`"$escaped`""
}

function Write-DeviceEnv([string]$Path, [string]$ControlUrl, [string]$DeviceId, [string]$NodeToken) {
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $tmp = "$Path.tmp.$PID"
  $lines = @(
    '# ChatDSH 设备连接凭据（由 device-join.ps1 维护）',
    "CHATDSH_CONTROL_URL=$(Format-EnvValue $ControlUrl)",
    "CHATDSH_DEVICE_ID=$(Format-EnvValue $DeviceId)",
    "CHATDSH_NODE_TOKEN=$(Format-EnvValue $NodeToken)"
  )
  [System.IO.File]::WriteAllLines($tmp, $lines, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $Path -Force
  try {
    & icacls.exe $Path /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
  } catch {
    # 非标准 ACL 文件系统时继续运行
  }
}

function Get-FileSha256Hex([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Verify-ArchiveSha256([string]$ArchivePath, [string]$ChecksumPath, [string]$ExpectedName) {
  $expected = ''
  foreach ($line in (Get-Content -LiteralPath $ChecksumPath -Encoding UTF8)) {
    if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
      $fileField = $Matches[2].Trim()
      if ($fileField -eq $ExpectedName -or [System.IO.Path]::GetFileName($fileField) -eq $ExpectedName) {
        $expected = $Matches[1].ToLowerInvariant()
        break
      }
    }
  }
  if ([string]::IsNullOrEmpty($expected)) {
    throw "SHA256SUMS.txt 中未找到 $ExpectedName 的校验记录"
  }
  $actual = Get-FileSha256Hex $ArchivePath
  if ($actual -ne $expected) {
    throw "插件归档 SHA-256 校验失败：期望 $expected，实际 $actual"
  }
}

function Invoke-TempNodeScript([string]$WorkDir, [string]$ScriptContent, [string[]]$ScriptArgs) {
  if (-not (Test-Path -LiteralPath $WorkDir)) {
    New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
  }
  $tmpScript = Join-Path $WorkDir ".chatdsh-helper-$PID-$([Guid]::NewGuid().ToString('N').Substring(0, 8)).cjs"
  try {
    [System.IO.File]::WriteAllText($tmpScript, $ScriptContent, (New-Object System.Text.UTF8Encoding($false)))
    $out = & node $tmpScript @ScriptArgs 2>$null
    return @{ ExitCode = $LASTEXITCODE; Output = $out }
  } finally {
    if (Test-Path -LiteralPath $tmpScript) {
      Remove-Item -LiteralPath $tmpScript -Force -ErrorAction SilentlyContinue
    }
  }
}

function Read-ProfileStoreDir([string]$ProfileDir, [string]$DshHome, [string]$DshBin) {
  $modulesYaml = Join-Path $ProfileDir 'node_modules\.modules.yaml'
  if (-not (Test-Path -LiteralPath $modulesYaml)) { return '' }
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
  $res = Invoke-TempNodeScript $DshHome $js @($modulesYaml, $DshBin)
  if ($res.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($res.Output)) {
    return ($res.Output | Select-Object -First 1).Trim()
  }
  return ''
}

function Resolve-StoreDir([string]$DshHome, [string]$ProfileName, [string]$DshBin) {
  if (-not [string]::IsNullOrWhiteSpace($env:pnpm_config_store_dir)) { return $env:pnpm_config_store_dir }
  if (-not [string]::IsNullOrWhiteSpace($env:npm_config_store_dir)) { return $env:npm_config_store_dir }
  if (-not [string]::IsNullOrWhiteSpace($env:CHATDSH_PNPM_STORE)) { return $env:CHATDSH_PNPM_STORE }
  $existing = Read-ProfileStoreDir (Join-Path $DshHome "profiles\$ProfileName") $DshHome $DshBin
  if (-not [string]::IsNullOrWhiteSpace($existing)) { return $existing }
  return (Join-Path $DshHome 'chatdsh-pnpm-store')
}

function Invoke-DshCommand([string]$DshBin, [string]$DshHome, [string]$StoreDir, [string[]]$DshArgs) {
  $prevHome = $env:DSH_HOME
  $prevNpm = $env:npm_config_store_dir
  $prevPnpm = $env:pnpm_config_store_dir
  try {
    $env:DSH_HOME = $DshHome
    if (-not [string]::IsNullOrWhiteSpace($StoreDir)) {
      $env:npm_config_store_dir = $StoreDir
      $env:pnpm_config_store_dir = $StoreDir
    }
    & $DshBin @DshArgs
    if ($LASTEXITCODE -ne 0) {
      throw "命令执行失败（退出码 $LASTEXITCODE）：$DshBin $($DshArgs -join ' ')"
    }
  } finally {
    $env:DSH_HOME = $prevHome
    $env:npm_config_store_dir = $prevNpm
    $env:pnpm_config_store_dir = $prevPnpm
  }
}

function Clear-CachedChatdshPackages([string]$ProfileDir) {
  $scopeDir = Join-Path $ProfileDir 'node_modules\@chatdsh'
  if (Test-Path -LiteralPath $scopeDir) { Remove-Item -LiteralPath $scopeDir -Recurse -Force }
  $lockFile = Join-Path $ProfileDir 'pnpm-lock.yaml'
  if (Test-Path -LiteralPath $lockFile) { Remove-Item -LiteralPath $lockFile -Force }
  $pnpmDir = Join-Path $ProfileDir 'node_modules\.pnpm'
  if (Test-Path -LiteralPath $pnpmDir) {
    Get-ChildItem -LiteralPath $pnpmDir -Filter '@chatdsh+*' -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
  }
}

function Check-PluginUpdate([string]$DshHome, [string]$ProfileName, [string]$Tag) {
  $profileDir = Join-Path $DshHome "profiles\$ProfileName"
  $tarballsDir = Join-Path $DshHome 'chatdsh-tarballs'
  $installed = Test-Path -LiteralPath (Join-Path $profileDir 'node_modules\@chatdsh\bundle')
  $localSha = ''
  $shaFile = Join-Path $tarballsDir '.archive.sha256'
  if (Test-Path -LiteralPath $shaFile) {
    $localSha = (Get-Content -LiteralPath $shaFile -Raw -Encoding UTF8).Trim().ToLowerInvariant()
  }
  $localCommit = ''
  $localBuiltAt = ''
  $manifestPath = Join-Path $tarballsDir 'manifest.json'
  if (Test-Path -LiteralPath $manifestPath) {
    try {
      $m = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($m.commit) { $localCommit = [string]$m.commit }
      if ($m.builtAt) { $localBuiltAt = [string]$m.builtAt }
    } catch {}
  }

  $releaseBase = Resolve-ReleaseBase $Tag
  $remoteSha = ''
  try {
    $sumsText = Invoke-RestMethod -Uri "$releaseBase/SHA256SUMS.txt" -TimeoutSec 30
    foreach ($line in ([string]$sumsText -split "`r?`n")) {
      if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
        $f = $Matches[2].Trim()
        if ($f -eq $BundleArchiveName -or [System.IO.Path]::GetFileName($f) -eq $BundleArchiveName) {
          $remoteSha = $Matches[1].ToLowerInvariant()
          break
        }
      }
    }
  } catch {}

  if (-not $installed) {
    Write-Output 'STATUS=not-installed'
  } elseif ([string]::IsNullOrEmpty($remoteSha)) {
    Write-Output 'STATUS=unknown'
    Write-Output 'REASON=remote-checksum-unavailable'
  } elseif (-not [string]::IsNullOrEmpty($localSha) -and $localSha -eq $remoteSha) {
    Write-Output 'STATUS=up-to-date'
  } else {
    Write-Output 'STATUS=update-available'
  }
  Write-Output "PROFILE=$ProfileName"
  Write-Output "RELEASE_TAG=$Tag"
  Write-Output "LOCAL_ARCHIVE_SHA256=$localSha"
  Write-Output "LOCAL_COMMIT=$localCommit"
  Write-Output "LOCAL_BUILT_AT=$localBuiltAt"
  Write-Output "REMOTE_ARCHIVE_SHA256=$remoteSha"
}

function Persist-StandaloneScript([string]$DshHome) {
  $saved = Join-Path $DshHome 'chatdsh-device-join.ps1'
  try {
    $utf8Bom = New-Object System.Text.UTF8Encoding($true)
    if (-not [string]::IsNullOrWhiteSpace($PSCommandPath) -and (Test-Path -LiteralPath $PSCommandPath) -and $PSCommandPath -ne $saved) {
      $content = [System.IO.File]::ReadAllText($PSCommandPath, [System.Text.Encoding]::UTF8)
      [System.IO.File]::WriteAllText($saved, $content.TrimStart([char]0xFEFF), $utf8Bom)
    } elseif (-not (Test-Path -LiteralPath $saved)) {
      $content = Invoke-RestMethod -Uri "$RawBase/scripts/device-join.ps1" -TimeoutSec 30
      if ($content -is [string] -and -not [string]::IsNullOrWhiteSpace($content)) {
        [System.IO.File]::WriteAllText($saved, $content.TrimStart([char]0xFEFF), $utf8Bom)
      }
    }
  } catch {}
}

function Install-Bundle([string]$DshHome, [string]$ProfileName, [string]$DshBin) {
  $store = Resolve-StoreDir $DshHome $ProfileName $DshBin
  if (-not (Test-Path -LiteralPath $store)) { New-Item -ItemType Directory -Path $store -Force | Out-Null }

  if (-not [string]::IsNullOrWhiteSpace($Bundle)) {
    Invoke-DshCommand $DshBin $DshHome $store @('plugin', '--profile', $ProfileName, 'add', $Bundle)
    return
  }

  $profileDir = Join-Path $DshHome "profiles\$ProfileName"
  if (-not (Test-Path -LiteralPath (Join-Path $profileDir 'pnpm-workspace.yaml'))) {
    Invoke-DshCommand $DshBin $DshHome $store @('--profile', $ProfileName, '--dump-config') | Out-Null
  }

  $downloadDir = Join-Path $DshHome 'chatdsh-download'
  if (-not (Test-Path -LiteralPath $downloadDir)) { New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null }

  $archiveFile = ''
  $checksumUrl = ''
  $archiveName = $BundleArchiveName

  if (-not [string]::IsNullOrWhiteSpace($BundleArchive)) {
    if ($BundleArchive -match '^https?://') {
      $archiveName = [System.IO.Path]::GetFileName(($BundleArchive -split '\?')[0])
      $archiveFile = Join-Path $downloadDir $archiveName
      Write-Host "正在下载插件归档：$BundleArchive"
      Invoke-WebRequest -Uri $BundleArchive -OutFile $archiveFile -UseBasicParsing -TimeoutSec 120
      if (-not $SkipChecksum) {
        $checksumUrl = ($BundleArchive.Substring(0, $BundleArchive.LastIndexOf('/'))) + '/SHA256SUMS.txt'
      }
    } else {
      if (-not (Test-Path -LiteralPath $BundleArchive)) {
        throw "未找到本地插件归档：$BundleArchive"
      }
      $archiveFile = (Resolve-Path -LiteralPath $BundleArchive).Path
      $archiveName = [System.IO.Path]::GetFileName($archiveFile)
      $localSum = Join-Path (Split-Path -Parent $archiveFile) 'SHA256SUMS.txt'
      if (-not $SkipChecksum -and (Test-Path -LiteralPath $localSum)) {
        Verify-ArchiveSha256 $archiveFile $localSum $archiveName
      }
    }
  } else {
    $releaseBase = Resolve-ReleaseBase $ReleaseTag
    $archiveUrl = "$releaseBase/$BundleArchiveName"
    $archiveFile = Join-Path $downloadDir $BundleArchiveName
    Write-Host "正在从 GitHub Releases 下载预构建插件归档（$ReleaseTag）..."
    Invoke-WebRequest -Uri $archiveUrl -OutFile $archiveFile -UseBasicParsing -TimeoutSec 120
    if (-not $SkipChecksum) {
      $checksumUrl = "$releaseBase/SHA256SUMS.txt"
    }
  }

  if (-not [string]::IsNullOrEmpty($checksumUrl)) {
    $checksumFile = Join-Path $downloadDir 'SHA256SUMS.txt'
    Invoke-WebRequest -Uri $checksumUrl -OutFile $checksumFile -UseBasicParsing -TimeoutSec 30
    Verify-ArchiveSha256 $archiveFile $checksumFile $archiveName
    Write-Host '插件归档 SHA-256 校验通过。'
  }

  $tarballsDir = Join-Path $DshHome 'chatdsh-tarballs'
  if (Test-Path -LiteralPath $tarballsDir) { Remove-Item -LiteralPath $tarballsDir -Recurse -Force }
  New-Item -ItemType Directory -Path $tarballsDir -Force | Out-Null

  & tar.exe -xzf $archiveFile -C $tarballsDir
  if ($LASTEXITCODE -ne 0) {
    throw "解压插件归档失败：$archiveFile"
  }
  [System.IO.File]::WriteAllText((Join-Path $tarballsDir '.archive.sha256'), "$(Get-FileSha256Hex $archiveFile)`n", (New-Object System.Text.UTF8Encoding($false)))

  $manifestFile = Join-Path $tarballsDir 'manifest.json'
  $applyScript = Join-Path $tarballsDir 'apply-overrides.cjs'
  if (-not (Test-Path -LiteralPath $manifestFile) -or -not (Test-Path -LiteralPath $applyScript)) {
    throw "插件归档结构不完整（缺少 manifest.json 或 apply-overrides.cjs）：$archiveFile"
  }

  & node $applyScript (Join-Path $profileDir 'pnpm-workspace.yaml') $manifestFile
  if ($LASTEXITCODE -ne 0) {
    throw '更新 pnpm-workspace.yaml overrides 失败'
  }

  $manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $bundleTarball = Join-Path $tarballsDir $manifest.bundle.tarball
  Clear-CachedChatdshPackages $profileDir
  Invoke-DshCommand $DshBin $DshHome $store @('plugin', '--profile', $ProfileName, 'add', $bundleTarball)
}

function Invoke-JsonPost([string]$Url, [hashtable]$Payload) {
  $json = ($Payload | ConvertTo-Json -Compress)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  try {
    $resp = Invoke-WebRequest -Uri $Url -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes -UseBasicParsing -TimeoutSec 15
    return @{ Status = [int]$resp.StatusCode; Body = $resp.Content }
  } catch [System.Net.WebException] {
    $webResp = $_.Exception.Response
    if ($null -eq $webResp) { throw }
    $reader = New-Object System.IO.StreamReader($webResp.GetResponseStream(), [System.Text.Encoding]::UTF8)
    $bodyText = $reader.ReadToEnd()
    $reader.Close()
    return @{ Status = [int]$webResp.StatusCode; Body = $bodyText }
  } catch {
    if ($_.Exception.PSObject.Properties['Response'] -and $null -ne $_.Exception.Response) {
      $statusCode = [int]$_.Exception.Response.StatusCode
      $bodyText = if ($_.ErrorDetails) { $_.ErrorDetails.Message } else { '' }
      return @{ Status = $statusCode; Body = $bodyText }
    }
    throw
  }
}

function Pair-Device([string]$Endpoint, [string]$PairingCode, [string]$DeviceName) {
  $url = "$($Endpoint.TrimEnd('/'))/chatdsh/gateway/devices/pair"
  $res = Invoke-JsonPost $url @{
    code         = $PairingCode
    name         = $DeviceName
    platform     = 'win32'
    role         = 'both'
    capabilities = @('shell')
  }

  if ($res.Status -eq 200) {
    $parsed = $res.Body | ConvertFrom-Json
    return @{ DeviceId = [string]$parsed.deviceId; Token = [string]$parsed.token }
  }
  if ($res.Status -ne 202) {
    if ($RedactSecrets) {
      throw "设备配对失败（HTTP $($res.Status)，详细地址与响应已脱敏）"
    }
    throw "设备配对失败（$url，HTTP $($res.Status)）：$($res.Body)"
  }

  $pending = $res.Body | ConvertFrom-Json
  $requestId = [string]$pending.requestId
  $pollToken = [string]$pending.pollToken
  Write-Host "配对申请已提交（requestId=$requestId），等待中继服务端审批放行..."
  Write-Host '请在中继宿主机执行以下命令审批：'
  Write-Host "  bash ~/.chatdsh/relay/relay-approve.sh approve $requestId"

  $claimUrl = "$($Endpoint.TrimEnd('/'))/chatdsh/gateway/devices/pair/claim"
  $deadline = (Get-Date).AddSeconds($ApprovalTimeout)
  $pollSec = if ($env:CHATDSH_PAIRING_POLL_SEC) { [double]$env:CHATDSH_PAIRING_POLL_SEC } else { 1.0 }

  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds ([int]($pollSec * 1000))
    $claim = Invoke-JsonPost $claimUrl @{ requestId = $requestId; pollToken = $pollToken }
    if ($claim.Status -eq 202) { continue }
    if ($claim.Status -eq 200) {
      $claimed = $claim.Body | ConvertFrom-Json
      return @{ DeviceId = [string]$claimed.deviceId; Token = [string]$claimed.token }
    }
    if ($claim.Status -eq 403) { throw "配对申请已被中继管理员拒绝（requestId=$requestId）。" }
    if ($claim.Status -eq 410) { throw "配对申请已过期（requestId=$requestId），请重新发起配对。" }
    if ($RedactSecrets) {
      throw "领取审批结果失败（HTTP $($claim.Status)，详细地址与响应已脱敏）"
    }
    throw "领取审批结果失败（$claimUrl，HTTP $($claim.Status)）：$($claim.Body)"
  }
  throw "等待中继审批超时（requestId=$requestId，超时 $ApprovalTimeout 秒）。"
}

function Read-PairingCodeSilent {
  $secure = Read-Host '请输入中继配对口令（输入不回显）' -AsSecureString
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim()
  } finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

$DshHomeResolved = if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $env:DSH_HOME.Trim() } else { Join-Path $env:USERPROFILE '.dsh' }
if ($CheckUpdate) {
  Check-PluginUpdate $DshHomeResolved $Profile $ReleaseTag
  return
}
if (-not (Test-Path -LiteralPath $DshHomeResolved)) { New-Item -ItemType Directory -Path $DshHomeResolved -Force | Out-Null }
Persist-StandaloneScript $DshHomeResolved

$DshBin = Resolve-DshBin

if (-not $SkipInstall) {
  Write-Host "[1/3] 正在安装 @chatdsh/bundle 到官方 $Profile profile（DSH_HOME=$DshHomeResolved）..."
  Install-Bundle $DshHomeResolved $Profile $DshBin
} else {
  Write-Host '[1/3] 已跳过插件安装。'
}

if ($InstallOnly) {
  Write-Host '插件安装完成（已按 -InstallOnly 退出）。'
  return
}

Write-Host '[2/3] 正在检查设备配对凭据...'
$envFile = Join-Path $DshHomeResolved 'chatdsh-device.env'
$saved = Read-EnvMap $envFile
$controlUrl = ''
if (-not [string]::IsNullOrWhiteSpace($Relay)) {
  $controlUrl = Normalize-PublicUrl $Relay
} elseif ($saved.ContainsKey('CHATDSH_CONTROL_URL') -and -not [string]::IsNullOrWhiteSpace($saved['CHATDSH_CONTROL_URL'])) {
  $controlUrl = Normalize-PublicUrl $saved['CHATDSH_CONTROL_URL']
} else {
  throw '缺少中继地址：首次接入请传入 -Relay <中继地址>'
}

$deviceId = ''
$nodeToken = ''
if (-not $RePair -and $saved['CHATDSH_DEVICE_ID'] -and $saved['CHATDSH_NODE_TOKEN'] -and $saved['CHATDSH_CONTROL_URL'] -eq $controlUrl) {
  $deviceId = $saved['CHATDSH_DEVICE_ID']
  $nodeToken = $saved['CHATDSH_NODE_TOKEN']
  Write-Host "复用已保存的设备凭据：deviceId=$deviceId（来源：$envFile）。"
} else {
  $pairingCode = if (-not [string]::IsNullOrWhiteSpace($Code)) { $Code.Trim() } else { Read-PairingCodeSilent }
  if ([string]::IsNullOrWhiteSpace($pairingCode)) {
    throw '缺少配对口令'
  }
  $pairEndpoint = if (-not [string]::IsNullOrWhiteSpace($PairUrl)) { Normalize-PublicUrl $PairUrl } else { $controlUrl }
  $devName = if (-not [string]::IsNullOrWhiteSpace($Name)) { $Name.Trim() } else { $env:COMPUTERNAME }
  if ([string]::IsNullOrWhiteSpace($devName)) { $devName = 'chatdsh-windows' }
  $pairResult = Pair-Device $pairEndpoint $pairingCode $devName
  $deviceId = $pairResult.DeviceId
  $nodeToken = $pairResult.Token
  Write-DeviceEnv $envFile $controlUrl $deviceId $nodeToken
  Write-Host "设备配对完成：deviceId=$deviceId，凭据已保存到 $envFile。"
}

$restartHint = "powershell -ExecutionPolicy Bypass -File `"$DshHomeResolved\chatdsh-device-join.ps1`""
if ($NoStart) {
  Write-Host "[3/3] 已按 -NoStart 跳过启动 DSH。后续启动执行：$restartHint"
  return
}

$dshArgs = @('--profile', $Profile)
if (-not [string]::IsNullOrWhiteSpace($Port)) {
  $dshArgs += @('--port', $Port)
}
if ($RedactSecrets) {
  Write-Host '[3/3] 正在启动官方 DSH（连接地址已由凭据文件注入，脱敏隐藏）...'
} else {
  Write-Host "[3/3] 正在启动官方 DSH（连接中继 $controlUrl）..."
}
Write-Host "提示：后续在本机重启只需执行 $restartHint。"

$env:DSH_HOME = $DshHomeResolved
$env:CHATDSH_CONTROL_URL = $controlUrl
$env:CHATDSH_DEVICE_ID = $deviceId
$env:CHATDSH_NODE_TOKEN = $nodeToken
& $DshBin @dshArgs
exit $LASTEXITCODE
