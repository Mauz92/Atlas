# S6 on Windows: signed update v0.1.0 -> v0.2.0 against a local http server (valid, tampered, wrong key).
# Usage: pwsh updater.ps1 -Dist <dir with v1\ v2\> -Work <scratch> -Out <results dir> [-Srv <dir to write the three latest.json sets to>]
param([Parameter(Mandatory)][string]$Dist, [Parameter(Mandatory)][string]$Work, [Parameter(Mandatory)][string]$Out, [string]$Srv)
. "$PSScriptRoot\common.ps1"
if (-not $Srv) { $Srv = "$Work\srv" }
$pw = [guid]::NewGuid().ToString('N'); $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $pw
$v1 = Get-Item "$Dist\v1\*_0.1.0_x64-setup.exe"; $v2 = Get-Item "$Dist\v2\*_0.2.0_x64-setup.exe"
$v2sig = (Get-Content -Raw "$($v2.FullName).sig").Trim()
New-Item -ItemType Directory -Force "$Work\keys" | Out-Null
Tauri signer generate -w "$Work\keys\other.key" -p $pw --ci -f | Out-Null

function Write-Latest($Dir, $Sig) {
  $o = [ordered]@{ version = '0.2.0'; notes = 'spike'; pub_date = '2026-11-04T00:00:00Z'
    platforms = @{ 'windows-x86_64' = [ordered]@{ signature = $Sig; url = 'http://127.0.0.1:18777/' + [uri]::EscapeDataString($v2.Name) } } }
  $o | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 "$Dir\latest.json"
}
Remove-Item -Recurse -Force $Srv -ErrorAction SilentlyContinue
foreach ($c in 'valid', 'tampered', 'wrongkey') { New-Item -ItemType Directory -Force "$Srv\$c" | Out-Null; Copy-Item $v2.FullName "$Srv\$c\" }
Write-Latest "$Srv\valid" $v2sig
$tb = [IO.File]::ReadAllBytes("$Srv\tampered\$($v2.Name)"); $tb[[int]($tb.Length / 2)] = $tb[[int]($tb.Length / 2)] -bxor 0xFF
[IO.File]::WriteAllBytes("$Srv\tampered\$($v2.Name)", $tb); Write-Latest "$Srv\tampered" $v2sig
Tauri signer sign -f "$Work\keys\other.key" -p $pw "$Srv\wrongkey\$($v2.Name)" | Out-Null
Write-Latest "$Srv\wrongkey" ((Get-Content -Raw "$Srv\wrongkey\$($v2.Name).sig").Trim())
Remove-Item "$Srv\wrongkey\$($v2.Name).sig"
Copy-Item (Join-Path $Spike 'scripts\update-server.mjs') $Srv

$results = [ordered]@{}
foreach ($case in 'valid', 'tampered', 'wrongkey') {
  Uninstall-Atlas
  $inst = Install-Atlas $v1.FullName
  $run = "$Work\run-$case"; Remove-Item -Recurse -Force $run -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force "$run\out" | Out-Null
  $server = Start-Process node -ArgumentList "`"$Srv\update-server.mjs`"", "`"$Srv\$case`"", '18777' -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 1
  $env:SPIKE_SUITE = 'updater'; $env:SPIKE_OUT = "$run\out"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $app = Start-Process $inst.exe -PassThru
  $exited = $app.WaitForExit(150000)
  $appSecs = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  Remove-Item Env:\SPIKE_SUITE, Env:\SPIKE_OUT
  # The NSIS updater starts the installer and ends the app, so the report may be missing on success: settle on the registered version.
  $want = if ($case -eq 'valid') { '0.2.0' } else { '0.1.0' }
  $deadline = (Get-Date).AddSeconds($(if ($case -eq 'valid') { 120 } else { 15 }))
  do { Start-Sleep -Seconds 2; $cur = (Get-AtlasInstall).display_version } while ($cur -ne '0.2.0' -and (Get-Date) -lt $deadline)
  $report = if (Test-Path "$run\out\updater.json") { Get-Content -Raw "$run\out\updater.json" | ConvertFrom-Json } else { $null }
  $i = Get-AtlasInstall
  $fileVer = if ($i -and (Test-Path $i.exe)) { (Get-Item $i.exe).VersionInfo.ProductVersion } else { $null }
  $results[$case] = [ordered]@{ install_v1 = $inst; app_exited = $exited; app_seconds = $appSecs; updater_report = $report; registered_version_after = $i.display_version
                                exe_product_version_after = $fileVer; expected_version = $want; PASS = ($i.display_version -eq $want) }
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  Get-Process -Name atlas-spike -ErrorAction SilentlyContinue | Stop-Process -Force
  Get-ChildItem "$run\out" -ErrorAction SilentlyContinue | Copy-Item -Destination (New-Item -ItemType Directory -Force "$Out\updater-$case") -Force
}
Uninstall-Atlas
$results['summary'] = 'valid must reach 0.2.0; tampered and wrongkey must stay 0.1.0 (refused). Runner user is an administrator: elevation-free update for a standard user is NOT proven here.'
Write-Json "$Out\updater-test.json" $results
Get-Content "$Out\updater-test.json"
