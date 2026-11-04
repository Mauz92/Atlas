# Per-user install of one NSIS setup and the facts that matter for SYNC-07 S7 (what a hosted admin runner CAN show).
param([Parameter(Mandatory)][string]$Setup, [Parameter(Mandatory)][string]$Out)
. "$PSScriptRoot\common.ps1"
# NSIS `RequestExecutionLevel user` is compiled into the installer manifest as asInvoker: no UAC prompt is requested.
$bytes = [IO.File]::ReadAllBytes($Setup)
$text = [Text.Encoding]::Latin1.GetString($bytes)
$m = [regex]::Match($text, 'requestedExecutionLevel\s+level\s*=\s*"(\w+)"')
$r = Install-Atlas $Setup
$r['setup_manifest_requested_execution_level'] = if ($m.Success) { $m.Groups[1].Value } else { 'not found' }
$r['setup_bytes'] = $bytes.Length
$r['runner_is_admin'] = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$r['note'] = 'Hosted runner user is an administrator: this does NOT prove UAC-free install for a standard user; it shows the per-user target and the asInvoker manifest.'
Write-Json $Out $r
Get-Content $Out
