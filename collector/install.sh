#!/bin/sh
# Set up the collector on this Mac: config, push key and a launchd job that runs every minute.
#   sh collector/install.sh mac-mini
# Safe to run again. It keeps an existing config and an existing key.
set -eu

machine=${1:?usage: sh collector/install.sh <mac-mini|macbook-air>}
here=$(cd "$(dirname "$0")" && pwd)
dir="$HOME/.config/agent-world"
config="$dir/config.json"
label="tech.stefannio.agent-world"
plist="$HOME/Library/LaunchAgents/$label.plist"
node=$(command -v node)

mkdir -p "$dir" "$HOME/Library/Logs"
if [ ! -f "$config" ]; then
  salt=$(openssl rand -hex 16)
  sed -e "s/\"mac-mini\"/\"$machine\"/" -e "s/written by install.sh/$salt/" "$here/config.example.json" > "$config"
  chmod 600 "$config"
  echo "Wrote $config"
fi

# The key goes straight from openssl into the keychain and is never printed.
if ! security find-generic-password -a agent-world -s agent-world-push >/dev/null 2>&1; then
  security add-generic-password -a agent-world -s agent-world-push -w "$(openssl rand -hex 32)"
  echo "Stored a new push key in the login keychain"
fi

cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>$node</string><string>$here/collect.mjs</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/agent-world.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/agent-world.log</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Running $label every minute. Log: ~/Library/Logs/agent-world.log"

# Only the hash of the key leaves this Mac. The site keeps hashes, never keys.
hash=$(security find-generic-password -a agent-world -s agent-world-push -w | tr -d '\n' | shasum -a 256 | cut -d' ' -f1)
echo
echo "Add this entry to AGENT_WORLD_KEYS in Vercel (Production), comma separated with the others:"
echo "  $machine:$hash"
