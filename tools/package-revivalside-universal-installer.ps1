param(
  [string]$OutputDir = "",
  [string]$RuntimeCacheDir = "",
  [string]$NodeVersion = "v22.22.3",
  [ValidateSet("win-x64", "win-x86", "win-arm64")]
  [string[]]$RuntimeIdentifiers = @("win-arm64", "win-x64", "win-x86"),
  [switch]$SkipWikiAssets
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$rootPath = $root.Path
if (-not $OutputDir) {
  $OutputDir = Join-Path $rootPath "prebuilt\revivalside-universal-installer"
}
if (-not $RuntimeCacheDir) {
  $RuntimeCacheDir = Join-Path $rootPath "prebuilt\revivalside-mega-runtimes"
}
$outputPath = [System.IO.Path]::GetFullPath($OutputDir)
$prebuiltRoot = [System.IO.Path]::GetFullPath((Join-Path $rootPath "prebuilt"))
$prebuiltRootWithSlash = $prebuiltRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if ($outputPath -ne $prebuiltRoot -and -not $outputPath.StartsWith($prebuiltRootWithSlash, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "OutputDir must stay under $prebuiltRoot; resolved OutputDir=$outputPath"
}

function Get-RidArchitecture([string]$Rid) {
  switch ($Rid) {
    "win-x64" { return "x64" }
    "win-x86" { return "x86" }
    "win-arm64" { return "arm64" }
    default { throw "Unsupported runtime identifier: $Rid" }
  }
}

function Get-CombatHostRid([string]$Rid) {
  if ($Rid -eq "win-arm64") { return "win-x64" }
  return $Rid
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
  if ($actual -ne $ExpectedArchitecture) {
    throw "$Name architecture mismatch: expected $ExpectedArchitecture, found $actual at $FilePath"
  }
}

function Copy-DirectoryClean([string]$Source, [string]$Destination) {
  if (Test-Path -LiteralPath $Destination) {
    Remove-Item -LiteralPath $Destination -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Copy-FileRequired([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source)) {
    throw "Required file was not found: $Source"
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Get-CombatHostSourceStamp([string]$CombatHostDir) {
  $hasher = [System.Security.Cryptography.IncrementalHash]::CreateHash([System.Security.Cryptography.HashAlgorithmName]::SHA1)
  $utf8 = [System.Text.Encoding]::UTF8
  $zero = [byte[]](0)
  $files = Get-ChildItem -LiteralPath $CombatHostDir -File |
    Where-Object { $_.Name.EndsWith(".cs", [System.StringComparison]::OrdinalIgnoreCase) -or $_.Name.EndsWith(".csproj", [System.StringComparison]::OrdinalIgnoreCase) } |
    Sort-Object Name
  foreach ($file in $files) {
    $hasher.AppendData($utf8.GetBytes($file.Name))
    $hasher.AppendData($zero)
    $hasher.AppendData([System.IO.File]::ReadAllBytes($file.FullName))
    $hasher.AppendData($zero)
  }
  return ([System.BitConverter]::ToString($hasher.GetHashAndReset()).Replace("-", "").ToLowerInvariant()).Substring(0, 16)
}

function Copy-CombatHostOriginalLayout([string]$Destination) {
  $sourceDir = Join-Path $rootPath "combat-host"
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $sourceDir -File |
    Where-Object { $_.Name.EndsWith(".cs", [System.StringComparison]::OrdinalIgnoreCase) -or $_.Name.EndsWith(".csproj", [System.StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Destination $_.Name) -Force }

  $stamp = Get-CombatHostSourceStamp $sourceDir
  $cacheOut = Join-Path $Destination "bin\host-cache\$stamp"
  if (Test-Path -LiteralPath $cacheOut) {
    Remove-Item -LiteralPath $cacheOut -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $cacheOut | Out-Null
  dotnet publish (Join-Path $sourceDir "CombatHost.csproj") `
    -c Release `
    --self-contained false `
    -p:DebugType=None `
    -p:DebugSymbols=false `
    --nologo `
    -o $cacheOut
  if ($LASTEXITCODE -ne 0) { throw "CombatHost project-cache publish failed" }
  foreach ($required in @("CombatHost.dll", "CombatHost.deps.json", "CombatHost.runtimeconfig.json")) {
    $requiredPath = Join-Path $cacheOut $required
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "CombatHost project-cache output is missing $requiredPath"
    }
  }
  Write-Host "CombatHost original project layout: source + host-cache\$stamp"
}

function Assert-GameplayJsons([string]$GameplayRoot, [string]$Name) {
  if (-not (Test-Path -LiteralPath $GameplayRoot -PathType Container)) {
    throw "$Name was not found: $GameplayRoot"
  }
  foreach ($requiredDirectory in @("Assetbundles", "StreamingAssets")) {
    $requiredPath = Join-Path $GameplayRoot $requiredDirectory
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Container)) {
      throw "$Name is missing $requiredDirectory`: $requiredPath"
    }
  }
  $defaultsPath = Join-Path $GameplayRoot "new-account-defaults.json"
  if (-not (Test-Path -LiteralPath $defaultsPath -PathType Leaf)) {
    throw "$Name is missing new-account-defaults.json: $defaultsPath"
  }
  $fileCount = (Get-ChildItem -LiteralPath $GameplayRoot -Recurse -File | Measure-Object).Count
  if ($fileCount -lt 1000) {
    throw "$Name looks incomplete: only $fileCount files were found at $GameplayRoot"
  }
  Write-Host "$Name`: $fileCount files at $GameplayRoot"
  return $fileCount
}

function Save-Url([string]$Url, [string]$Destination) {
  if (Test-Path -LiteralPath $Destination) { return }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
}

function Resolve-NodeRuntime([string]$Rid) {
  $expectedArch = Get-RidArchitecture $Rid
  $cachedNode = Join-Path $RuntimeCacheDir "node\$Rid\node.exe"
  $cachedNpm = Join-Path $RuntimeCacheDir "node\$Rid\npm.cmd"
  if ((Test-Path -LiteralPath $cachedNode) -and (Test-Path -LiteralPath $cachedNpm) -and ((Get-PeMachine $cachedNode) -eq $expectedArch)) {
    return $cachedNode
  }

  $nodeArch = switch ($Rid) {
    "win-x64" { "x64" }
    "win-x86" { "x86" }
    "win-arm64" { "arm64" }
  }
  $fileName = "node-$NodeVersion-win-$nodeArch.zip"
  $zipPath = Join-Path $RuntimeCacheDir "downloads\$fileName"
  Save-Url "https://nodejs.org/dist/$NodeVersion/$fileName" $zipPath

  $extractRoot = Join-Path $RuntimeCacheDir "node-expand\$Rid"
  if (Test-Path -LiteralPath $extractRoot) {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force
  $nodeDir = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
  if (-not $nodeDir) { throw "Node archive did not contain a runtime directory: $zipPath" }

  $cachedDir = Split-Path -Parent $cachedNode
  if (Test-Path -LiteralPath $cachedDir) {
    Remove-Item -LiteralPath $cachedDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $cachedDir | Out-Null
  Get-ChildItem -LiteralPath $nodeDir.FullName -Force | Copy-Item -Destination $cachedDir -Recurse -Force
  Assert-ExecutableArchitecture $cachedNode $expectedArch "node.exe"
  if (-not (Test-Path -LiteralPath $cachedNpm)) {
    throw "Node archive did not contain npm.cmd: $zipPath"
  }
  return $cachedNode
}

function Remove-IfPresent([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Remove-PdbFiles([string]$Directory) {
  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return }
  Get-ChildItem -LiteralPath $Directory -File -Filter "*.pdb" -ErrorAction SilentlyContinue |
    Remove-Item -Force
}

if (Test-Path -LiteralPath $outputPath) {
  Remove-Item -LiteralPath $outputPath -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null

$payloadRoot = Join-Path $outputPath "payload"
$appPayload = Join-Path $payloadRoot "app"

Write-Host "Building shared app payload"
$sharedArgs = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", (Join-Path $rootPath "tools\package-revivalside-mega-release.ps1"),
  "-RuntimeIdentifier", "win-x64",
  "-OutputDir", $appPayload,
  "-NodePath", (Resolve-NodeRuntime "win-x64")
)
if ($SkipWikiAssets) { $sharedArgs += "-SkipWikiAssets" }
& powershell @sharedArgs
if ($LASTEXITCODE -ne 0) {
  throw "Shared app payload build failed"
}

foreach ($relative in @(
  "RevivalSideLauncher.exe",
  "RevivalSideLauncher.pdb",
  "combat-host",
  "runtime",
  "Install RevivalSide.ps1",
  "Install RevivalSide.bat",
  "README.txt"
)) {
  Remove-IfPresent (Join-Path $appPayload $relative)
}
Remove-PdbFiles $appPayload
Assert-GameplayJsons (Join-Path $appPayload "gameplay-jsons") "shared app payload gameplay-jsons" | Out-Null

foreach ($rid in $RuntimeIdentifiers) {
  $arch = Get-RidArchitecture $rid
  $runtimeOut = Join-Path $payloadRoot "runtime-apps\$rid"
  New-Item -ItemType Directory -Force -Path $runtimeOut | Out-Null

  Write-Host "Publishing launcher/combat host for $rid"
  dotnet publish (Join-Path $rootPath "tools\RevivalSideLauncherApp\RevivalSideLauncherApp.csproj") `
    -c Release -r $rid --self-contained true `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true `
    -p:DebugType=None -p:DebugSymbols=false --nologo `
    -o $runtimeOut
  if ($LASTEXITCODE -ne 0) { throw "Launcher publish failed for $rid" }
  Remove-PdbFiles $runtimeOut
  Assert-ExecutableArchitecture (Join-Path $runtimeOut "RevivalSideLauncher.exe") $arch "RevivalSideLauncher.exe"

  $combatOut = Join-Path $runtimeOut "combat-host"
  $combatRid = Get-CombatHostRid $rid
  $combatArch = Get-RidArchitecture $combatRid
  dotnet publish (Join-Path $rootPath "combat-host\CombatHost.csproj") `
    -c Release -r $combatRid --self-contained true `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true `
    -p:DebugType=None -p:DebugSymbols=false --nologo `
    -o $combatOut
  if ($LASTEXITCODE -ne 0) { throw "CombatHost publish failed for $rid" }
  Assert-ExecutableArchitecture (Join-Path $combatOut "CombatHost.exe") $combatArch "CombatHost.exe"
  Copy-CombatHostOriginalLayout $combatOut

  $nodeExe = Resolve-NodeRuntime $rid
  Copy-DirectoryClean (Split-Path -Parent $nodeExe) (Join-Path $payloadRoot "runtime-node\$rid")
}

Write-Host "Publishing universal setup"
dotnet publish (Join-Path $rootPath "tools\RevivalSideInstallerApp\RevivalSideInstallerApp.csproj") `
  -c Release -r win-x86 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true `
  -p:DebugType=None -p:DebugSymbols=false --nologo `
  -o $outputPath
if ($LASTEXITCODE -ne 0) {
  throw "Setup publish failed"
}
Remove-PdbFiles $outputPath
Assert-ExecutableArchitecture (Join-Path $outputPath "RevivalSideSetup.exe") "x86" "RevivalSideSetup.exe"

@"
RevivalSide Universal Windows Installer

Run RevivalSideSetup.exe. The setup app detects the Windows architecture and
installs the matching launcher, combat host, and Node runtime.

This folder intentionally stores app data once instead of producing separate
win-arm64, win-x64, and win-x86 release bundles.
"@ | Set-Content -LiteralPath (Join-Path $outputPath "README.txt") -Encoding UTF8

Write-Host "Packaged $outputPath"
