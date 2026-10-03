#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
swift build --package-path "$root" -c release
bin="$(swift build --package-path "$root" -c release --show-bin-path)"
for product in VLMKitNativeAgent VLMKitAXFixture; do
  if [[ "$product" == VLMKitNativeAgent ]]; then id=com.f4ah6o.vlmkit.native-agent; else id=com.f4ah6o.vlmkit.ax-fixture; fi
  bundle="$root/dist/$product.app"
  mkdir -p "$bundle/Contents/MacOS"
  cp "$bin/$product" "$bundle/Contents/MacOS/$product"
  cat > "$bundle/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleExecutable</key><string>$product</string>
<key>CFBundleIdentifier</key><string>$id</string>
<key>CFBundleName</key><string>$product</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
  codesign --force --sign "${VLMKIT_NATIVE_SIGN_IDENTITY:--}" "$bundle"
done
if [[ "${1:-}" == --build-only ]]; then exit 0; fi
pkill -x VLMKitAXFixture || true
/usr/bin/open -n "$root/dist/VLMKitAXFixture.app" --args "$@"
