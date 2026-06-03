param(
  [switch]$Remove,
  [string]$Address = "127.0.0.1",
  [string[]]$Names = @(
    "ctsglobal-login.sbside.com"
  )
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell prompt."
  }
}

Assert-Admin

$hostsPath = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
$markerStart = "# BEGIN RevivalSide"
$markerEnd = "# END RevivalSide"

function Read-TextFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return ""
  }
  $text = [System.IO.File]::ReadAllText($Path)
  if ($null -eq $text) {
    return ""
  }
  return $text
}

function Write-TextFileAtomic {
  param(
    [string]$Path,
    [string]$Text
  )

  $directory = Split-Path -Parent $Path
  $fileName = Split-Path -Leaf $Path
  $tmpPath = Join-Path $directory ".$fileName.revivalside.tmp"
  [System.IO.File]::WriteAllText($tmpPath, $Text, [System.Text.Encoding]::ASCII)
  Move-Item -LiteralPath $tmpPath -Destination $Path -Force
}

$backupPath = "$hostsPath.revivalside.$(Get-Date -Format yyyyMMddHHmmss).bak"
if (Test-Path -LiteralPath $hostsPath) {
  Copy-Item -LiteralPath $hostsPath -Destination $backupPath -Force
} else {
  [System.IO.File]::WriteAllText($backupPath, "", [System.Text.Encoding]::ASCII)
}

$content = Read-TextFile -Path $hostsPath

$pattern = "(?ms)^$([regex]::Escape($markerStart)).*?^$([regex]::Escape($markerEnd))\r?\n?"
$content = [regex]::Replace($content, $pattern, "")

if (-not $Remove) {
  $block = @(
    $markerStart
    "$Address $($Names -join ' ')"
    $markerEnd
    ""
  ) -join [Environment]::NewLine

  if ($content.Length -gt 0 -and -not $content.EndsWith([Environment]::NewLine)) {
    $content += [Environment]::NewLine
  }
  $content += $block
}

Write-TextFileAtomic -Path $hostsPath -Text $content
Write-Host "[hosts] updated $hostsPath"
Write-Host "[hosts] backup $backupPath"
try {
  ipconfig /flushdns | Out-Null
  Write-Host "[hosts] dns cache flushed"
} catch {
  Write-Warning "[hosts] dns cache flush failed: $($_.Exception.Message)"
}
