param(
  [string]$Otp,   # npm 要求两步验证时，填认证器上的 6 位码
  [switch]$Web    # 改用浏览器批准流程
)

# 发布 dsh-savetoken-autolaunch 到公共 npm 源。
# 本机 npm 默认指向 registry.npmmirror.com（只读镜像），所以每条命令都显式钉住官方源。

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$registry = 'https://registry.npmjs.org/'
$npm = 'npm.cmd'
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json
$name = $manifest.name
$version = $manifest.version

Write-Host "包: $name@$version" -ForegroundColor Cyan
if ($manifest.private) { throw 'package.json 里还有 "private": true，无法发布。' }

# --- 1. 登录检查（关键闸门）-------------------------------------------------
$who = $null
try { $who = (& $npm whoami --registry=$registry 2>$null) } catch { $who = $null }
if (-not $who) {
  Write-Host "whoami 失败：令牌无效或未登录。先修好凭证再发布，否则必然 401/403/404。" -ForegroundColor Yellow
  Write-Host "  有效令牌要求：Granular Access Token + All packages + Read and write + Bypass 2FA" -ForegroundColor Yellow
  Write-Host "  设置：npm config set //registry.npmjs.org/:_authToken 新令牌" -ForegroundColor Yellow
  Write-Host "  自测：npm whoami --registry=$registry   必须打印你的用户名" -ForegroundColor Yellow
  exit 1
}
Write-Host "已登录为: $who" -ForegroundColor Green

# --- 2. 防重复发布 ----------------------------------------------------------
$published = $null
try { $published = (& $npm view "$name@$version" version --registry=$registry 2>$null) } catch { $published = $null }
if ($published) {
  Write-Host "$name@$version 已发布过，请先改大 package.json 的 version。" -ForegroundColor Yellow
  exit 1
}

# --- 3. 上传内容预览 --------------------------------------------------------
Write-Host "`n即将上传:" -ForegroundColor Cyan
& $npm pack --dry-run 2>&1 | Select-String -Pattern 'npm notice' | ForEach-Object { $_.Line }

# --- 4. 发布 ---------------------------------------------------------------
Write-Host "`n发布中…" -ForegroundColor Cyan
$publishArgs = @('publish', "--registry=$registry", '--access', 'public')
if ($Otp) { $publishArgs += "--otp=$Otp" }
if ($Web) { $publishArgs += '--auth-type=web' }
& $npm @publishArgs

if ($LASTEXITCODE -ne 0) {
  Write-Host "`n发布失败。若报 403 且提到 two-factor，说明账号的写入被要求两步验证：" -ForegroundColor Yellow
  Write-Host "  A. powershell -File publish.ps1 -Otp 123456   （认证器 6 位码，30 秒过期）" -ForegroundColor Yellow
  Write-Host "  B. 建 Bypass 2FA 的细粒度令牌后重设 _authToken（推荐，一劳永逸）" -ForegroundColor Yellow
  exit $LASTEXITCODE
}

Write-Host "`n发布完成。对方在「添加插件」里填： $name" -ForegroundColor Green
Write-Host "立刻装若报 not-found，是镜像还没同步（通常几分钟）。" -ForegroundColor DarkGray
