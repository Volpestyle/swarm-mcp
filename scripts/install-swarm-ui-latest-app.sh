#!/usr/bin/env bash
set -Eeuo pipefail

ICON_SOURCE="/Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui/src-tauri/icons/icon.icns"
LAUNCH_SCRIPT="/Users/mathewfrazier/Desktop/swarm-mcp-lab/scripts/open-latest-swarm-ui.sh"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

install_launcher_app() {
  local app="$1"
  local name="$2"
  local identifier="$3"
  local executable_name="$4"
  local contents="$app/Contents"
  local macos="$contents/MacOS"
  local resources="$contents/Resources"
  local executable="$macos/$executable_name"
  local plist="$contents/Info.plist"

  rm -rf "$app"
  mkdir -p "$macos" "$resources"

  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>$executable_name</string>
  <key>CFBundleIconFile</key>
  <string>swarm-ui</string>
  <key>CFBundleIdentifier</key>
  <string>$identifier</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$name</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
</dict>
</plist>
PLIST

  cat > "$executable" <<EOF
#!/usr/bin/env bash
exec "$LAUNCH_SCRIPT"
EOF

  chmod +x "$executable"
  cp "$ICON_SOURCE" "$resources/swarm-ui.icns"
  /usr/bin/codesign --force --deep --sign - "$app" >/dev/null
  touch "$app"
  "$LSREGISTER" -f "$app" >/dev/null 2>&1 || true
  echo "$app"
}

install_launcher_app \
  "/Users/mathewfrazier/Applications/Swarm UI Latest.app" \
  "Swarm UI Latest" \
  "com.frazier.swarm-ui-latest" \
  "SwarmUILatest"

install_launcher_app \
  "/Users/mathewfrazier/Applications/Swarm UI Lab.app" \
  "Swarm UI Lab" \
  "com.frazier.swarm-ui-lab-launcher" \
  "SwarmUILab"
