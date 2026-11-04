# Builds the per-user NSIS installers v0.1.0 and v0.2.0 with a THROWAWAY updater key pair generated here.
# Usage: pwsh build.ps1 -Work <scratch dir> -Dist <output dir>   (run from anywhere; needs node_modules installed and the Rust MSVC toolchain)
# The private key and its password stay in -Work (never copied to -Dist); only the public key and the signatures are published.
param([Parameter(Mandatory)][string]$Work, [Parameter(Mandatory)][string]$Dist)
. "$PSScriptRoot\common.ps1"
New-Item -ItemType Directory -Force "$Work\keys", "$Dist\v1", "$Dist\v2" | Out-Null
$pw = [guid]::NewGuid().ToString('N')
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $pw
Set-Content -NoNewline -Encoding ascii "$Work\keys\pw.txt" $pw
Push-Location $Spike
try {
  Tauri signer generate -w "$Work\keys\test.key" -p $pw --ci -f | Out-Null
  $pub = (Get-Content -Raw "$Work\keys\test.key.pub").Trim()
  $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -Raw "$Work\keys\test.key").Trim()
  Set-Content -Encoding ascii "$Dist\updater-public-key.txt" $pub

  & node node_modules\esbuild\bin\esbuild ui/src/harness.js --bundle --format=iife --outfile=ui/harness.bundle.js --log-level=warning
  if ($LASTEXITCODE -ne 0) { throw 'esbuild failed' }

  $timings = [ordered]@{}; $raw = [ordered]@{}
  foreach ($v in '0.1.0', '0.2.0') {
    $dir = if ($v -eq '0.1.0') { 'v1' } else { 'v2' }
    $cfg = [ordered]@{
      version = $v
      bundle  = [ordered]@{ targets = @('nsis'); windows = @{ nsis = @{ installMode = 'currentUser' } } }
      plugins = @{ updater = @{ pubkey = $pub } }
    }
    $cfgPath = "$Work\tauri-$v.json"
    $cfg | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 $cfgPath
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Tauri build -c $cfgPath --bundles nsis
    $timings["build_${v}_seconds"] = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    $nsis = "$Spike\target\release\bundle\nsis"
    Copy-Item "$nsis\*_${v}_x64-setup.exe*" "$Dist\$dir\"
    $raw[$v] = (Get-Item "$Spike\target\release\atlas-spike.exe").Length   # bare binary size (not published)
  }
  $files = Get-ChildItem -Recurse "$Dist\v1", "$Dist\v2" -File | ForEach-Object { [ordered]@{ path = $_.FullName.Substring($Dist.Length + 1); bytes = $_.Length; sha256 = (Get-FileHash $_.FullName).Hash } }
  Write-Json "$Dist\build-summary.json" ([ordered]@{ timings = $timings; raw_exe_bytes = $raw; files = $files; rustc = (rustc -V); cargo = (cargo -V); node = (node -v) })
  Get-Content "$Dist\build-summary.json"
} finally { Pop-Location }
