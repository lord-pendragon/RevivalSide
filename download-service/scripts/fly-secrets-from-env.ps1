param(
  [string]$EnvPath = ".env",
  [string]$AppName = "downloadside"
)

$ErrorActionPreference = "Stop"

$serviceRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
if (-not [System.IO.Path]::IsPathRooted($EnvPath)) {
  $EnvPath = Join-Path $serviceRoot.Path $EnvPath
}

if (-not (Test-Path -LiteralPath $EnvPath -PathType Leaf)) {
  throw "Environment file was not found: $EnvPath"
}

$secretKeys = @(
  "SERVICE_NAME",
  "DOWNLOAD_PUBLIC_BASE_URL",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_REDIRECT_URI",
  "DISCORD_GUILD_ID",
  "DISCORD_ALLOWED_ROLE_ID",
  "SESSION_SECRET",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "GITHUB_TOKEN",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY"
)

function Read-EnvFile([string]$Path) {
  $values = [ordered]@{}
  foreach ($rawLine in Get-Content -LiteralPath $Path) {
    $line = $rawLine.TrimStart([char]0xFEFF).Trim()
    if (-not $line -or $line.StartsWith("#")) { continue }
    if ($line.StartsWith("export ", [System.StringComparison]::OrdinalIgnoreCase)) {
      $line = $line.Substring(7).TrimStart([char]0xFEFF).TrimStart()
    }

    $separator = $line.IndexOf("=")
    if ($separator -le 0) { continue }

    $key = $line.Substring(0, $separator).TrimStart([char]0xFEFF).Trim()
    if ($key -notmatch "^[A-Za-z_][A-Za-z0-9_]*$") { continue }

    $value = $line.Substring($separator + 1).Trim()
    if ($value.Length -ge 2) {
      $quote = $value[0]
      if (($quote -eq '"' -or $quote -eq "'") -and $value[$value.Length - 1] -eq $quote) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }

    $values[$key] = $value
  }
  return $values
}

$envValues = Read-EnvFile $EnvPath
$importLines = New-Object System.Collections.Generic.List[string]

foreach ($key in $secretKeys) {
  if (-not $envValues.Contains($key)) { continue }
  $value = [string]$envValues[$key]
  if ([string]::IsNullOrWhiteSpace($value)) { continue }
  $importLines.Add("$key=$value")
}

if ($importLines.Count -eq 0) {
  throw "No non-empty DownloadSide deploy variables were found in $EnvPath"
}

if ($AppName -notmatch "^[A-Za-z0-9-]+$") {
  throw "Fly app name contains unsupported characters for this helper: $AppName"
}

Write-Host "Importing $($importLines.Count) DownloadSide variables from $EnvPath into Fly app '$AppName'."
$importText = [string]::Join([Environment]::NewLine, $importLines) + [Environment]::NewLine

$tempPath = [System.IO.Path]::GetTempFileName()
try {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $importBytes = $utf8NoBom.GetBytes($importText)
  [System.IO.File]::WriteAllBytes($tempPath, $importBytes)

  & cmd.exe /d /s /c "flyctl secrets import --stage --app $AppName < ""$tempPath"""
  if ($LASTEXITCODE -ne 0) {
    throw "flyctl secrets import failed."
  }
}
finally {
  Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
}
