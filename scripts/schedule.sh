#!/bin/zsh
# Runs `npm run check` every day on this Mac via launchd.
#   ./scripts/schedule.sh install [HH:MM]   default 08:30
#   ./scripts/schedule.sh uninstall
#   ./scripts/schedule.sh status
# If the Mac is asleep at that time, launchd runs the check when it wakes.
set -euo pipefail

LABEL="dev.dalechang.job-watch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

case "${1:-}" in
  install)
    TIME="${2:-08:30}"
    HOUR=$((10#${TIME%%:*})); MINUTE=$((10#${TIME##*:}))
    mkdir -p "$HOME/Library/LaunchAgents" "$DIR/data"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd "$DIR" &amp;&amp; npm run --silent check</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer></dict>
  <key>StandardOutPath</key><string>$DIR/data/schedule.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/schedule.log</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Scheduled daily at $(printf '%02d:%02d' $HOUR $MINUTE). Log: $DIR/data/schedule.log"
    echo "Run it now with: launchctl kickstart gui/$(id -u)/$LABEL"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed."
    ;;
  status)
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|last exit|runs" || echo "Not installed."
    ;;
  *)
    echo "usage: $0 install [HH:MM] | uninstall | status"; exit 1;;
esac
