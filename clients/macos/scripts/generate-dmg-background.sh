#!/usr/bin/env bash
set -euo pipefail

# Generate the DMG background image for the Electron installer.
#
# Renders "Install Vellum" / "Double click the icon below" onto a white canvas
# using AppKit (system SF Pro font), producing both a standard and an @2x
# (retina) PNG that electron-builder's `dmg.background` consumes. The single
# app icon itself is drawn by Finder at the `dmg.contents` position — this only
# paints the instructional text.
#
# Uses Swift/AppKit (always present on macOS build runners) rather than a
# homebrew renderer like rsvg-convert, mirroring scripts/generate-icon.sh, so
# the build stays self-contained in CI.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$APP_DIR/build"
mkdir -p "$OUTPUT_DIR"

TITLE="Install Vellum"
SUBTITLE="Double click the icon below"

render() {
  local scale="$1" out="$2"
  swift - "$out" "$scale" "$TITLE" "$SUBTITLE" <<'SWIFT_SCRIPT'
import AppKit
import Foundation

let output = CommandLine.arguments[1]
let scale = CGFloat(Double(CommandLine.arguments[2])!)
let title = CommandLine.arguments[3]
let subtitle = CommandLine.arguments[4]

// Logical canvas — must match dmg.window in electron-builder.config.cjs.
// We render directly into a `scale`-times-larger pixel buffer (rep.size ==
// pixel dimensions) and scale every coordinate ourselves, so the geometry is
// deterministic regardless of NSBitmapImageRep point/pixel behavior.
let width = 540 * scale
let height = 420 * scale

guard
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: Int(width),
        pixelsHigh: Int(height),
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )
else { fatalError("generate-dmg-background: could not allocate bitmap") }
rep.size = NSSize(width: width, height: height)

guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else {
    fatalError("generate-dmg-background: could not create graphics context")
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = ctx

NSColor.white.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()

// AppKit's origin is bottom-left; `fromTop` is a top-anchored vertical center
// (in points), converted into that space and scaled to pixels.
func drawCentered(_ text: String, font: NSFont, color: NSColor, fromTop: CGFloat) {
    let para = NSMutableParagraphStyle()
    para.alignment = .center
    let str = NSAttributedString(
        string: text,
        attributes: [.font: font, .foregroundColor: color, .paragraphStyle: para]
    )
    let h = str.size().height
    let y = height - fromTop * scale - h / 2
    str.draw(in: NSRect(x: 0, y: y, width: width, height: h))
}

// `fromTop` values are tuned against the DMG window's *visible* content
// height (window height minus the ~32pt title bar). The single app icon is
// drawn by Finder at dmg.contents below this text; keep the three in sync so
// the icon + label sit centered between the subtitle and the window bottom.
drawCentered(
    title,
    font: .systemFont(ofSize: 30 * scale, weight: .semibold),
    color: NSColor(white: 0.11, alpha: 1),
    fromTop: 54
)
drawCentered(
    subtitle,
    font: .systemFont(ofSize: 16 * scale, weight: .regular),
    color: NSColor(white: 0.43, alpha: 1),
    fromTop: 94
)

NSGraphicsContext.restoreGraphicsState()

guard let data = rep.representation(using: .png, properties: [:]) else {
    fatalError("generate-dmg-background: PNG encode failed")
}
try! data.write(to: URL(fileURLWithPath: output))
SWIFT_SCRIPT
}

render 1 "$OUTPUT_DIR/dmg-background.png"
render 2 "$OUTPUT_DIR/dmg-background@2x.png"

echo "generate-dmg-background: wrote dmg-background.png + @2x to $OUTPUT_DIR"
