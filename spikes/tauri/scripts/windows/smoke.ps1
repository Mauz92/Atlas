# Smoke launch of the INSTALLED app on the runner: cold start, harness suites that need no external stack, single instance, idle memory.
# Usage: pwsh smoke.ps1 -Out <results dir> -Work <scratch>   (the per-user install must exist)
param([Parameter(Mandatory)][string]$Out, [Parameter(Mandatory)][string]$Work)
. "$PSScriptRoot\common.ps1"
$ErrorActionPreference = 'Continue'
$inst = Get-AtlasInstall
if (-not $inst) { throw 'Atlas Spike is not installed' }
$exe = $inst.exe
$res = [ordered]@{ exe = $exe; exe_bytes = (Get-Item $exe).Length }
$wv = Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue
$res['webview2_runtime_version'] = $wv.pv
$res['os'] = (Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber)
$res['culture'] = (Get-Culture).Name; $res['timezone'] = (Get-TimeZone).Id
function Reset-Env { 'SPIKE_SUITE', 'SPIKE_OUT', 'SPIKE_DB', 'SPIKE_NOTES' | ForEach-Object { Remove-Item "Env:\$_" -ErrorAction SilentlyContinue } }

# Harness suite: start with SPIKE_SUITE, wait for its report (the page calls exit_app when done).
function Run-Suite($name, $timeoutSec = 90) {
  $o = "$Work\suite-$name"; Remove-Item -Recurse -Force $o -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force $o | Out-Null
  $env:SPIKE_SUITE = $name; $env:SPIKE_OUT = $o; $env:SPIKE_DB = "$o\app.db"; $env:SPIKE_NOTES = "$Work\notes"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process $exe -PassThru
  $report = "$o\harness-$name.json"
  while (-not (Test-Path $report) -and -not $p.HasExited -and $sw.Elapsed.TotalSeconds -lt $timeoutSec) { Start-Sleep -Milliseconds 100 }
  $toReport = [math]::Round($sw.Elapsed.TotalSeconds, 2)
  $exited = $p.WaitForExit(15000)
  if (-not $exited) { $p.Kill() }
  Reset-Env
  Get-Process -Name atlas-spike -ErrorAction SilentlyContinue | Stop-Process -Force
  if (Test-Path $report) { Copy-Item $report "$Out\harness-$name.json" -Force }
  Get-ChildItem $o -Filter *.json -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne "harness-$name.json" } | Copy-Item -Destination $Out -Force
  [ordered]@{ suite = $name; report_written = (Test-Path $report); seconds_to_report = $toReport; app_exited_by_itself = $exited; exit_code = $(if ($p.HasExited) { $p.ExitCode } else { $null }) }
}

# Notes folder for the fsscope suite (symlink cases only if the runner may create them).
$n = "$Work\notes"; New-Item -ItemType Directory -Force "$n\sub" | Out-Null
Set-Content "$n\a.md" "# a`n"; Set-Content "$n\sub\b.md" "# b`n"; Set-Content "$n\.hidden.md" "# h`n"
Set-Content "$Work\outside-secret.txt" 'secret'; New-Item -ItemType Directory -Force "$Work\notes-sibling" | Out-Null; Set-Content "$Work\notes-sibling\x.md" 'x'
try { New-Item -ItemType SymbolicLink -Path "$n\link-to-outside.md" -Target "$Work\outside-secret.txt" -ErrorAction Stop | Out-Null; New-Item -ItemType SymbolicLink -Path "$n\linkdir" -Target $Work -ErrorAction Stop | Out-Null; $res['symlinks_created'] = $true } catch { $res['symlinks_created'] = "no: $($_.Exception.Message)" }

# Cold start: three launches of the probe suite; the first follows a fresh install (closest to cold available on a runner).
$cold = @(); 1..3 | ForEach-Object { $cold += (Run-Suite 'probe') }
$res['cold_start_probe_runs'] = $cold
foreach ($s in 'ipc', 'keystore', 'fsscope', 'notify') { $res["suite_$s"] = Run-Suite $s }

# Single instance (X1) + idle memory (S9)
$si = "$Work\si"; Remove-Item -Recurse -Force $si -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force $si | Out-Null
$env:SPIKE_SUITE = 'hold'; $env:SPIKE_OUT = $si; $env:SPIKE_DB = "$si\app.db"
$first = Start-Process $exe -PassThru
Remove-Item Env:\SPIKE_SUITE   # the second launch must not inherit it (harmless either way)
Start-Sleep -Seconds 10
$second = Start-Process $exe -ArgumentList '--second-launch', 'marker' -PassThru
$sw = [Diagnostics.Stopwatch]::StartNew(); $secondExited = $second.WaitForExit(20000)
$secondSecs = [math]::Round($sw.Elapsed.TotalSeconds, 2)
Start-Sleep -Seconds 3
$siReport = if (Test-Path "$si\single-instance.json") { Get-Content -Raw "$si\single-instance.json" | ConvertFrom-Json } else { $null }
$res['single_instance'] = [ordered]@{ first_still_running = -not $first.HasExited; second_exited = $secondExited; second_seconds_to_exit = $secondSecs; second_exit_code = $(if ($second.HasExited) { $second.ExitCode } else { $null })
                                      atlas_spike_process_count = @(Get-Process -Name atlas-spike -ErrorAction SilentlyContinue).Count; first_instance_received = $siReport }
Start-Sleep -Seconds 20
$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, WorkingSetSize
$ids = @($first.Id); do { $before = $ids.Count; $ids = @($ids + ($procs | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object ProcessId) | Sort-Object -Unique) } while ($ids.Count -ne $before)
$mine = $procs | Where-Object { $ids -contains $_.ProcessId }
$res['idle_memory'] = [ordered]@{ after_seconds = 30; processes = @($mine | ForEach-Object { [ordered]@{ name = $_.Name; working_set_mb = [math]::Round($_.WorkingSetSize / 1MB, 1) } }); total_working_set_mb = [math]::Round((($mine | Measure-Object WorkingSetSize -Sum).Sum) / 1MB, 1)
                                  note = 'Working set (not private bytes); window may be hidden/unfocused on a runner; 30 s idle, not the 10 min of the checklist; no 5000-note folder.' }
Get-Process -Name atlas-spike, msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Reset-Env
Write-Json "$Out\smoke.json" $res
Get-Content "$Out\smoke.json"
