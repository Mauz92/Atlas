# S2/S3/S4 headless checks of atlas-spike-core on Windows. Expects `cargo build -p atlas-spike-core --release` to have run.
# Every check records exit code, duration, stdout JSON lines and stderr; nothing is skipped silently.
param([Parameter(Mandatory)][string]$Out)
. "$PSScriptRoot\common.ps1"
$bin = Join-Path $Spike 'target\release\spike-headless.exe'
$tmp = Join-Path $env:RUNNER_TEMP 'spike-headless'; Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force $tmp | Out-Null
New-Item -ItemType Directory -Force $Out | Out-Null
$checks = @(
  @{ name = 'sqlite-bench';  args = @('sqlite-bench', "$tmp\s2") },
  @{ name = 'sqlite-kill';   args = @('sqlite-kill', "$tmp\kill", '100') },
  @{ name = 'notes-scan';    args = @('notes-scan', "$tmp\scan", '5000') },
  @{ name = 'keyring';       args = @('keyring') },
  # notes-watch shells out to sh, mv, rm, touch -d, stat, seq: Git for Windows provides them on the runner (usr\bin).
  @{ name = 'notes-watch';   args = @('notes-watch', "$tmp\watch"); gitbash = $true }
)
$meta = @()
$ErrorActionPreference = 'Continue'
foreach ($c in $checks) {
  $oldPath = $env:PATH
  if ($c.gitbash) { $env:PATH = "C:\Program Files\Git\usr\bin;C:\Program Files\Git\bin;$env:PATH" }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $stdoutF = "$Out\headless-$($c.name).stdout.txt"; $stderrF = "$Out\headless-$($c.name).stderr.txt"
  $p = Start-Process -FilePath $bin -ArgumentList $c.args -NoNewWindow -PassThru -RedirectStandardOutput $stdoutF -RedirectStandardError $stderrF
  $done = $p.WaitForExit(600000)
  if (-not $done) { $p.Kill() }
  $env:PATH = $oldPath
  $meta += [ordered]@{ check = $c.name; exit_code = $(if ($done) { $p.ExitCode } else { 'TIMEOUT' }); seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
                       stdout_lines = @(Get-Content $stdoutF -ErrorAction SilentlyContinue).Count; stderr_head = ((Get-Content $stderrF -TotalCount 12 -ErrorAction SilentlyContinue) -join "`n") }
}
Get-Content "$Out\headless-*.stdout.txt" | Set-Content -Encoding utf8 "$Out\headless.jsonl"
Write-Json "$Out\headless-meta.json" $meta
Get-Content "$Out\headless.jsonl"
Get-Content "$Out\headless-meta.json"
# Leftover credential (the keyring check deletes its own entry; this shows whether anything remains).
cmdkey /list | Select-String 'atlas-spike' | Out-File "$Out\credential-manager-after.txt"
