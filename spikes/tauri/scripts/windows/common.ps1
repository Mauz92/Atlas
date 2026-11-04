# Shared helpers for the Windows-runner scripts (SYNC-07 spike). Dot-source: . "$PSScriptRoot\common.ps1"
$ErrorActionPreference = 'Stop'
$Spike = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
function Tauri { & node (Join-Path $Spike 'node_modules\@tauri-apps\cli\tauri.js') @args; if ($LASTEXITCODE -ne 0) { throw "tauri $($args -join ' ') failed ($LASTEXITCODE)" } }
function Write-Json($Path, $Obj) { New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null; $Obj | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 $Path }
# The per-user installer registers itself under HKCU; a machine-wide one would use HKLM. Returns the entry or $null.
function Get-AtlasUninstallEntry($Hive) {
  $root = "${Hive}:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
  if (-not (Test-Path $root)) { return $null }
  Get-ChildItem $root | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'Atlas Spike*' } | Select-Object -First 1
}

function Get-AtlasInstall {
  $u = Get-AtlasUninstallEntry 'HKCU'
  if ($null -eq $u) { return $null }
  $dir = $u.InstallLocation
  if (-not $dir) { $dir = Split-Path -Parent ($u.UninstallString -replace '"', '') }
  [ordered]@{ display_name = $u.DisplayName; display_version = $u.DisplayVersion; install_dir = $dir.TrimEnd('\'); exe = (Join-Path $dir.TrimEnd('\') 'atlas-spike.exe'); uninstall = ($u.UninstallString -replace '"', '') }
}

# Silent per-user install (NSIS /S). Returns facts about what was installed where.
function Install-Atlas($Setup) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $Setup -ArgumentList '/S' -Wait -PassThru
  $secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  $i = Get-AtlasInstall
  $hklm = Get-AtlasUninstallEntry 'HKLM'
  $exeExists = $i -and (Test-Path $i.exe)
  $under = $i -and $i.install_dir.StartsWith($env:LOCALAPPDATA, [StringComparison]::OrdinalIgnoreCase)
  $size = if ($exeExists) { [int64](Get-ChildItem -Recurse -File $i.install_dir | Measure-Object Length -Sum).Sum } else { 0 }
  [ordered]@{ setup = (Split-Path -Leaf $Setup); exit_code = $p.ExitCode; seconds = $secs; hkcu_entry = [bool]$i; hklm_entry = [bool]$hklm
              install_dir = $i.install_dir; under_localappdata = [bool]$under; exe_exists = [bool]$exeExists; version_registered = $i.display_version; installed_bytes = $size }
}

# NSIS uninstallers copy themselves to %TEMP% and return at once, so wait for the registry entry to go.
function Uninstall-Atlas {
  Get-Process -Name atlas-spike -ErrorAction SilentlyContinue | Stop-Process -Force
  $i = Get-AtlasInstall
  if ($null -eq $i) { return }
  Start-Process -FilePath $i.uninstall -ArgumentList '/S' -Wait | Out-Null
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-AtlasInstall) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  Start-Sleep -Seconds 2
}
