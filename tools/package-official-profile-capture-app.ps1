param(
  [string]$OutputDir = "",
  [ValidateSet("win-x64", "win-x86", "win-arm64")]
  [string]$RuntimeIdentifier = "",
  [string]$NodePath = "",
  [string]$WiresharkDir = "",
  [switch]$SkipWireshark,
  [switch]$IncludeGameplayJsons,
  [switch]$Zip
)

$ErrorActionPreference = "Stop"

function Get-HostWindowsRid {
  $dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
  if ($dotnetCommand) {
    $ridLine = (& dotnet --info 2>$null | Select-String -Pattern "^\s*RID:\s*(\S+)" | Select-Object -First 1)
    if ($ridLine -and $ridLine.Matches.Count -gt 0) {
      $rid = $ridLine.Matches[0].Groups[1].Value
      if ($rid -in @("win-x64", "win-x86", "win-arm64")) { return $rid }
    }
  }
  $processorText = "$env:PROCESSOR_ARCHITECTURE $env:PROCESSOR_ARCHITEW6432 $env:PROCESSOR_IDENTIFIER"
  if ($processorText -match "ARM64|ARMv8|AARCH64") { return "win-arm64" }
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  switch ($arch) {
    "x64" { return "win-x64" }
    "x86" { return "win-x86" }
    "arm64" { return "win-arm64" }
    default { throw "Unsupported Windows host architecture: $arch" }
  }
}

function Get-RidArchitecture([string]$Rid) {
  switch ($Rid) {
    "win-x64" { return "x64" }
    "win-x86" { return "x86" }
    "win-arm64" { return "arm64" }
    default { throw "Unsupported runtime identifier: $Rid" }
  }
}

function Get-PeMachine([string]$FilePath) {
  if (-not (Test-Path -LiteralPath $FilePath)) { return "" }
  $bytes = [System.IO.File]::ReadAllBytes($FilePath)
  if ($bytes.Length -lt 64) { return "" }
  if ([System.BitConverter]::ToUInt16($bytes, 0) -ne 0x5A4D) { return "" }
  $peOffset = [System.BitConverter]::ToInt32($bytes, 0x3C)
  if ($peOffset -lt 0 -or ($peOffset + 6) -gt $bytes.Length) { return "" }
  $machine = [System.BitConverter]::ToUInt16($bytes, $peOffset + 4)
  switch ($machine) {
    0x014c { return "x86" }
    0x8664 { return "x64" }
    0xaa64 { return "arm64" }
    0x01c4 { return "arm" }
    default { return ("0x{0:x}" -f $machine) }
  }
}

function Assert-ExecutableArchitecture([string]$FilePath, [string]$ExpectedArchitecture, [string]$Name) {
  if (-not (Test-Path -LiteralPath $FilePath)) {
    throw "$Name was not found: $FilePath"
  }
  $actual = Get-PeMachine $FilePath
  if (-not $actual) {
    throw "$Name is not a Windows PE executable: $FilePath"
  }
  if ($actual -ne $ExpectedArchitecture) {
    throw "$Name architecture mismatch for ${RuntimeIdentifier}: expected $ExpectedArchitecture, found $actual at $FilePath"
  }
}

if (-not $RuntimeIdentifier) {
  $RuntimeIdentifier = Get-HostWindowsRid
}
$targetArch = Get-RidArchitecture $RuntimeIdentifier

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$rootPath = $root.Path
if (-not $OutputDir) {
  $OutputDir = Join-Path $rootPath "prebuilt\official-profile-capture-app"
}
$outputPath = [System.IO.Path]::GetFullPath($OutputDir)
$prebuiltRoot = [System.IO.Path]::GetFullPath((Join-Path $rootPath "prebuilt"))
if (-not $outputPath.StartsWith($prebuiltRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "OutputDir must stay under $prebuiltRoot"
}

if (-not $NodePath) {
  $nodeCommand = Get-Command node -ErrorAction Stop
  $NodePath = $nodeCommand.Source
}
Assert-ExecutableArchitecture $NodePath $targetArch "node.exe"

if (-not $SkipWireshark) {
  if (-not $WiresharkDir) {
    $defaultWireshark = Join-Path $env:ProgramFiles "Wireshark"
    if (Test-Path -LiteralPath $defaultWireshark) {
      $WiresharkDir = $defaultWireshark
    } else {
      $tsharkCommand = Get-Command tshark -ErrorAction Stop
      $WiresharkDir = Split-Path -Parent $tsharkCommand.Source
    }
  }
  Assert-ExecutableArchitecture (Join-Path $WiresharkDir "dumpcap.exe") $targetArch "dumpcap.exe"
  Assert-ExecutableArchitecture (Join-Path $WiresharkDir "tshark.exe") $targetArch "tshark.exe"
}

if (Test-Path -LiteralPath $outputPath) {
  Remove-Item -LiteralPath $outputPath -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
$appRoot = Join-Path $outputPath "app"
New-Item -ItemType Directory -Force -Path $appRoot | Out-Null

dotnet publish (Join-Path $rootPath "tools\OfficialProfileCaptureApp\OfficialProfileCaptureApp.csproj") `
  -c Release `
  -r $RuntimeIdentifier `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:EnableCompressionInSingleFile=true `
  -p:DebugType=None `
  -p:DebugSymbols=false `
  --nologo `
  -o $outputPath

$captureExe = Join-Path $outputPath "RevivalSideOfficialProfileCapture.exe"
Assert-ExecutableArchitecture $captureExe $targetArch "RevivalSideOfficialProfileCapture.exe"

$combatHostOut = Join-Path $appRoot "combat-host"
dotnet publish (Join-Path $rootPath "combat-host\CombatHost.csproj") `
  -c Release `
  -r $RuntimeIdentifier `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:EnableCompressionInSingleFile=true `
  -p:DebugType=None `
  -p:DebugSymbols=false `
  --nologo `
  -o $combatHostOut

$combatHostExe = Join-Path $combatHostOut "CombatHost.exe"
Assert-ExecutableArchitecture $combatHostExe $targetArch "CombatHost.exe"

Copy-Item -LiteralPath (Join-Path $rootPath "package.json") -Destination (Join-Path $appRoot "package.json") -Force

New-Item -ItemType Directory -Force -Path (Join-Path $appRoot "tools") | Out-Null
Copy-Item -LiteralPath (Join-Path $rootPath "tools\extract-cs-pcap-fixtures.js") -Destination (Join-Path $appRoot "tools\extract-cs-pcap-fixtures.js") -Force
Copy-Item -LiteralPath (Join-Path $rootPath "tools\import-official-join-lobby-profile.js") -Destination (Join-Path $appRoot "tools\import-official-join-lobby-profile.js") -Force

New-Item -ItemType Directory -Force -Path (Join-Path $appRoot "modules") | Out-Null
Copy-Item -LiteralPath (Join-Path $rootPath "modules\official-profile-import") -Destination (Join-Path $appRoot "modules\official-profile-import") -Recurse -Force
Copy-Item -LiteralPath (Join-Path $rootPath "combat-handler") -Destination (Join-Path $appRoot "combat-handler") -Recurse -Force

New-Item -ItemType Directory -Force -Path (Join-Path $appRoot "server") | Out-Null
Copy-Item -LiteralPath (Join-Path $rootPath "server\userManager.js") -Destination (Join-Path $appRoot "server\userManager.js") -Force

$gameplayJsons = Join-Path $rootPath "gameplay-jsons"
if ($IncludeGameplayJsons -and (Test-Path -LiteralPath $gameplayJsons)) {
  Copy-Item -LiteralPath $gameplayJsons -Destination (Join-Path $appRoot "gameplay-jsons") -Recurse -Force
}

$serverDataDir = Join-Path $appRoot "server-data"
New-Item -ItemType Directory -Force -Path $serverDataDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $serverDataDir "capture-extracts") | Out-Null
$seedUsersJson = @{
  schemaVersion = 1
  nextUserUid = "1000000001"
  nextFriendCode = "10000001"
  activeUserUid = ""
  users = @{}
} | ConvertTo-Json -Depth 8
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $serverDataDir "users.json"), "$seedUsersJson$([Environment]::NewLine)", $utf8NoBom)
New-Item -ItemType Directory -Force -Path (Join-Path $appRoot "captures") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $appRoot "exports") | Out-Null

$nodeOut = Join-Path $outputPath "runtime\node"
New-Item -ItemType Directory -Force -Path $nodeOut | Out-Null
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $nodeOut "node.exe") -Force
Assert-ExecutableArchitecture (Join-Path $nodeOut "node.exe") $targetArch "bundled node.exe"

if (-not $SkipWireshark) {
  $wiresharkOut = Join-Path $outputPath "runtime\Wireshark"
  New-Item -ItemType Directory -Force -Path $wiresharkOut | Out-Null
  Copy-Item -Path (Join-Path $WiresharkDir "*") -Destination $wiresharkOut -Recurse -Force
  Assert-ExecutableArchitecture (Join-Path $wiresharkOut "dumpcap.exe") $targetArch "bundled dumpcap.exe"
  Assert-ExecutableArchitecture (Join-Path $wiresharkOut "tshark.exe") $targetArch "bundled tshark.exe"
}

@"
RevivalSide Official Profile Capture ($RuntimeIdentifier)

Run RevivalSideOfficialProfileCapture.exe.
Start recording before opening/logging into the official client, stop after the
lobby fully loads, then extract.

This package is built for $RuntimeIdentifier. If Windows says dumpcap.exe,
tshark.exe, node.exe, or CombatHost.exe is not valid for this OS platform,
use the package whose name matches the target PC CPU architecture.

Layout:
- RevivalSideOfficialProfileCapture.exe launches the app.
- app\ contains scripts, clean local users.json, captures, exports, and CombatHost.
- runtime\ contains bundled Node and Wireshark CLI files for $RuntimeIdentifier.

External requirements:
- Npcap must be installed for live packet capture.
- CounterSide Data\Managed must exist locally so Assembly-CSharp.dll can be read.
  The app will try to find Steam libraries automatically. If it cannot, click
  Browse and select Assembly-CSharp.dll once; the path is saved in
  app\capture-settings.json. You can also set CS_COUNTERSIDE_MANAGED_DIR before launch.

Optional:
- Pass -IncludeGameplayJsons to this packaging script if you want to bundle gameplay-jsons too.
"@ | Set-Content -LiteralPath (Join-Path $outputPath "README.txt") -Encoding UTF8

if ($Zip) {
  $zipPath = "$outputPath.zip"
  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  Compress-Archive -Path (Join-Path $outputPath "*") -DestinationPath $zipPath -Force
  Write-Host "Packaged $zipPath"
} else {
  Write-Host "Packaged $outputPath"
}
