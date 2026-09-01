# setup-windows-build.ps1 — install the toolchain needed to build the T3 Code
# Windows desktop installer, then build it.
#
# WHY THIS EXISTS: the NSIS installer cannot be built from WSL. It needs the
# Rust x86_64-pc-windows-msvc target (MSVC linker) for native/resource-monitor
# and rcedit for the executable metadata. Upstream builds it on a native
# Windows runner; this is the local equivalent.
#
# RUN FROM AN ELEVATED POWERSHELL ("Run as administrator"). The Visual Studio
# Build Tools and Node.js installers are machine-scope and will fail without it.
#
# Disk: ~6-8 GB (VS Build Tools dominates). First run takes a while.
#
#   powershell -ExecutionPolicy Bypass -File scripts\admera\setup-windows-build.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\admera\setup-windows-build.ps1 -SkipInstall  # build only
#
[CmdletBinding()]
param(
  # Windows-side checkout. Do NOT build from \\wsl$ or /mnt — the pnpm store and
  # electron-builder both suffer badly across that boundary.
  [string]$RepoDir = "$env:USERPROFILE\src\t3code",
  [string]$Branch = "main",
  [switch]$SkipInstall,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Winget {
  param([string]$Id, [string[]]$Extra = @())
  Write-Host "==> winget install $Id" -ForegroundColor Cyan
  $argv = @("install", "--id", $Id, "--exact", "--accept-package-agreements",
            "--accept-source-agreements", "--disable-interactivity") + $Extra
  & winget @argv
  # 0 = installed, -1978335189 = already installed at the requested version.
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
    throw "winget install $Id failed with exit code $LASTEXITCODE"
  }
}

if (-not $SkipInstall) {
  if (-not (Test-Admin)) {
    throw "Not elevated. Close this window and reopen PowerShell with 'Run as administrator'."
  }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget not found. Install 'App Installer' from the Microsoft Store first."
  }

  Invoke-Winget "Git.Git"
  Invoke-Winget "OpenJS.NodeJS.LTS"
  Invoke-Winget "Rustlang.Rustup"

  # The VCTools workload is what supplies link.exe for the MSVC Rust target.
  # --override replaces winget's default args, so the workload must be named here.
  Invoke-Winget "Microsoft.VisualStudio.2022.BuildTools" @(
    "--override",
    "--wait --quiet --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  )

  # Pick up PATH changes the installers made without needing a new shell.
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path", "User")

  Write-Host "==> rustup: MSVC toolchain + target" -ForegroundColor Cyan
  & rustup toolchain install stable-x86_64-pc-windows-msvc
  if ($LASTEXITCODE -ne 0) { throw "rustup toolchain install failed" }
  & rustup target add x86_64-pc-windows-msvc
  if ($LASTEXITCODE -ne 0) { throw "rustup target add failed" }

  # The repo pins pnpm via packageManager; corepack honours that pin.
  Write-Host "==> corepack/pnpm" -ForegroundColor Cyan
  & corepack enable pnpm
  if ($LASTEXITCODE -ne 0) { throw "corepack enable pnpm failed" }
}

foreach ($tool in @("git", "node", "cargo")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "$tool is still not on PATH. Open a NEW elevated PowerShell and re-run with -SkipInstall."
  }
}
Write-Host ("node {0} / cargo {1}" -f (& node -v), (& cargo --version)) -ForegroundColor Green

if (-not (Test-Path $RepoDir)) {
  Write-Host "==> cloning into $RepoDir" -ForegroundColor Cyan
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $RepoDir) | Out-Null
  & git clone --branch $Branch https://github.com/Admerahealth/t3code.git $RepoDir
  if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
}

Set-Location $RepoDir
& git fetch origin $Branch; & git checkout $Branch; & git pull --ff-only origin $Branch

if ($SkipBuild) { Write-Host "-SkipBuild set; stopping before the build." ; exit 0 }

Write-Host "==> pnpm install" -ForegroundColor Cyan
& corepack pnpm install
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }

# Emits the NSIS installer, latest.yml and the .blockmap under release/.
# latest.yml is what electron-updater reads, so it must ship in the GitHub release.
Write-Host "==> building Windows installer (this takes a while)" -ForegroundColor Cyan
& corepack pnpm run dist:desktop:win
if ($LASTEXITCODE -ne 0) { throw "dist:desktop:win failed" }

Write-Host "`nArtifacts:" -ForegroundColor Green
Get-ChildItem -Path (Join-Path $RepoDir "release") -Include *.exe, *.yml, *.blockmap -Recurse |
  Select-Object Name, Length | Format-Table -AutoSize

Write-Host @"

Next steps
  1. Attach the .exe, latest.yml and .blockmap to a GitHub release on
     Admerahealth/t3code whose tag is a version ABOVE the installed one.
     latest.yml is mandatory - without it the updater cannot resolve an update.
  2. Only then repoint resources\app-update.yml to owner: Admerahealth, so the
     app stops checking pingdotgg. Repointing before a real installer exists
     makes every update check fail.
  3. The build is unsigned, so SmartScreen will warn on first install.
"@ -ForegroundColor Yellow
