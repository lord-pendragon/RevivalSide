param(
    [Parameter(Mandatory = $true)]
    [Alias("Host")]
    [string]$TargetHost,

    [string]$User = "ubuntu",

    [string]$KeyPath = "$HOME\.ssh\id_ed25519",

    [string]$RemoteDir = "/home/ubuntu/revivalside-discord-bot"
)

$ErrorActionPreference = "Stop"

$rootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$requiredFiles = @(
    "package.json",
    "package-lock.json",
    ".env",
    "tools\discord-join-bot.js"
)

foreach ($file in $requiredFiles) {
    $path = Join-Path $rootDir $file
    if (!(Test-Path $path)) {
        throw "Missing required deployment file: $path"
    }
}

if (!(Test-Path $KeyPath)) {
    throw "SSH key not found: $KeyPath"
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "revivalside-discord-bot-$([Guid]::NewGuid())"
$archivePath = "$tempRoot.tar.gz"

try {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $tempRoot "tools") | Out-Null

    Copy-Item (Join-Path $rootDir "package.json") (Join-Path $tempRoot "package.json")
    Copy-Item (Join-Path $rootDir "package-lock.json") (Join-Path $tempRoot "package-lock.json")
    Copy-Item (Join-Path $rootDir ".env") (Join-Path $tempRoot ".env")
    Copy-Item (Join-Path $rootDir "tools\discord-join-bot.js") (Join-Path $tempRoot "tools\discord-join-bot.js")

    $target = "$User@$TargetHost"
    $remoteArchive = "$RemoteDir/revivalside-discord-bot.tar.gz"

    ssh -i $KeyPath $target "mkdir -p '$RemoteDir'"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create remote deployment directory."
    }

    tar --force-local -czf $archivePath -C $tempRoot .
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create deployment archive."
    }

    scp -i $KeyPath $archivePath "${target}:$remoteArchive"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to upload deployment archive."
    }

    $remoteScript = @'
set -euo pipefail

REMOTE_DIR="$1"
NODE_HOME="$HOME/.local/node22"
SERVICE_NAME="revivalside-discord-bot"

cd "$REMOTE_DIR"

missing_tools=""
for tool in ca-certificates curl tar xz; do
  case "$tool" in
    ca-certificates) continue ;;
    *) command -v "$tool" >/dev/null 2>&1 || missing_tools="$missing_tools $tool" ;;
  esac
done

if [ -n "$missing_tools" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y ca-certificates curl tar xz-utils
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y ca-certificates curl tar xz
  else
    echo "Missing required tools and no supported package manager was found:$missing_tools" >&2
    exit 1
  fi
fi

if [ ! -x "$NODE_HOME/bin/node" ]; then
  tmpdir="$(mktemp -d)"
  arch="$(uname -m)"
  case "$arch" in
    x86_64) node_arch="linux-x64" ;;
    aarch64|arm64) node_arch="linux-arm64" ;;
    *) echo "Unsupported CPU architecture for Node binary: $arch" >&2; exit 1 ;;
  esac

  archive="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk -v node_arch="$node_arch" '$2 ~ node_arch".tar.xz$" {print $2; exit}')"
  if [ -z "$archive" ]; then
    echo "Could not resolve latest Node 22 archive for $node_arch" >&2
    exit 1
  fi

  curl -fSL "https://nodejs.org/dist/latest-v22.x/$archive" -o "$tmpdir/node.tar.xz"
  rm -rf "$NODE_HOME"
  mkdir -p "$NODE_HOME"
  tar -xJf "$tmpdir/node.tar.xz" -C "$NODE_HOME" --strip-components=1
  rm -rf "$tmpdir"
fi

if command -v getenforce >/dev/null 2>&1 && command -v chcon >/dev/null 2>&1 && [ "$(getenforce)" = "Enforcing" ]; then
  sudo chcon -R -t bin_t "$NODE_HOME" || true
fi

tar -xzf revivalside-discord-bot.tar.gz
mkdir -p server-data

export PATH="$NODE_HOME/bin:$PATH"
node -v
npm -v
npm ci --omit=dev --no-audit --no-fund
node --check tools/discord-join-bot.js

sudo tee "/etc/systemd/system/$SERVICE_NAME.service" >/dev/null <<SERVICE
[Unit]
Description=RevivalSide Discord role bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$REMOTE_DIR
Environment=PATH=$NODE_HOME/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$NODE_HOME/bin/node tools/discord-join-bot.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME.service"
sudo systemctl restart "$SERVICE_NAME.service"
sleep 8
systemctl is-active "$SERVICE_NAME.service"
sudo systemctl status "$SERVICE_NAME.service" --no-pager -l | sed -n '1,35p'
sudo journalctl -u "$SERVICE_NAME.service" -n 80 --no-pager
'@

    $remoteScript = $remoteScript -replace "`r", ""
    $remoteScript | ssh -i $KeyPath $target "bash -s -- '$RemoteDir'"
    if ($LASTEXITCODE -ne 0) {
        throw "Remote deployment failed."
    }
}
finally {
    if (Test-Path $archivePath) {
        Remove-Item -LiteralPath $archivePath -Force
    }
    if (Test-Path $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
