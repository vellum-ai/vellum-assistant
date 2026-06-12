#!/usr/bin/env bash
set -euo pipefail

# Generate a per-environment AppIcon.icns for the Electron build.
# Reads VELLUM_ENVIRONMENT (default: local) and renders the matching icon from
# clients/macos/build-resources/icons/{env}/ into build/icon.icns.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

VELLUM_ENVIRONMENT="${VELLUM_ENVIRONMENT:-local}"
ICONS_DIR="$REPO_ROOT/clients/macos/build-resources/icons"

if [ -d "$ICONS_DIR/$VELLUM_ENVIRONMENT" ]; then
    ICON_SOURCE_DIR="$ICONS_DIR/$VELLUM_ENVIRONMENT"
elif [ -d "$ICONS_DIR/production" ]; then
    echo "generate-icon: no icons for '$VELLUM_ENVIRONMENT', falling back to production"
    ICON_SOURCE_DIR="$ICONS_DIR/production"
else
    echo "generate-icon: no icon sources found at $ICONS_DIR" >&2
    exit 1
fi

echo "generate-icon: using $VELLUM_ENVIRONMENT icon from $ICON_SOURCE_DIR"

OUTPUT_DIR="$APP_DIR/build"
mkdir -p "$OUTPUT_DIR"

MASTER_PNG=$(mktemp /tmp/appicon-master-XXXXXX).png
ICONSET_DIR=$(mktemp -d)/AppIcon.iconset
mkdir -p "$ICONSET_DIR"

trap 'rm -rf "$MASTER_PNG" "$(dirname "$ICONSET_DIR")"' EXIT

swift - "$ICON_SOURCE_DIR" "$MASTER_PNG" <<'SWIFT_SCRIPT'
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let iconDir = CommandLine.arguments[1]
let outputPath = CommandLine.arguments[2]

let jsonPath = iconDir + "/icon.json"
let jsonData = try! Data(contentsOf: URL(fileURLWithPath: jsonPath))
let json = try! JSONSerialization.jsonObject(with: jsonData) as! [String: Any]

let fillDict = json["fill"] as! [String: Any]
let solidStr = fillDict["solid"] as! String
let colorParts = solidStr.split(separator: ":")[1].split(separator: ",").map { CGFloat(Double($0)!) }
let fillColor = CGColor(
    colorSpace: CGColorSpace(name: CGColorSpace.displayP3)!,
    components: colorParts
)!

let groups = json["groups"] as! [[String: Any]]
let layers = groups[0]["layers"] as! [[String: Any]]
let layer = layers[0]
let position = layer["position"] as! [String: Any]
let scale = CGFloat(position["scale"] as! Double)
let translationPts = position["translation-in-points"] as! [Double]
let txPoints = CGFloat(translationPts[0])
let tyPoints = CGFloat(translationPts[1])

let imageName = layer["image-name"] as! String
let svgPath = iconDir + "/Assets/" + imageName

let svgString = try! String(contentsOfFile: svgPath, encoding: .utf8)
let dRange = svgString.range(of: "d=\"")!
let afterD = svgString[dRange.upperBound...]
let closingQuote = afterD.firstIndex(of: "\"")!
let pathData = String(afterD[..<closingQuote])

let vbRange = svgString.range(of: "viewBox=\"")!
let afterVB = svgString[vbRange.upperBound...]
let vbClose = afterVB.firstIndex(of: "\"")!
let vbParts = String(afterVB[..<vbClose]).split(separator: " ").map { CGFloat(Double($0)!) }
let svgWidth = vbParts[2]
let svgHeight = vbParts[3]

func parseSVGPath(_ d: String) -> CGPath {
    let path = CGMutablePath()
    let chars = Array(d)
    var i = 0
    var currentX: CGFloat = 0
    var currentY: CGFloat = 0

    func skipWhitespaceAndCommas() {
        while i < chars.count && (chars[i] == " " || chars[i] == "," || chars[i] == "\n" || chars[i] == "\r" || chars[i] == "\t") {
            i += 1
        }
    }

    func parseNumber() -> CGFloat {
        skipWhitespaceAndCommas()
        var numStr = ""
        if i < chars.count && (chars[i] == "-" || chars[i] == "+") {
            numStr.append(chars[i]); i += 1
        }
        while i < chars.count && (chars[i] >= "0" && chars[i] <= "9" || chars[i] == ".") {
            numStr.append(chars[i]); i += 1
        }
        return CGFloat(Double(numStr) ?? 0)
    }

    var lastCmd: Character = " "

    while i < chars.count {
        skipWhitespaceAndCommas()
        if i >= chars.count { break }

        var cmd: Character
        if chars[i].isLetter {
            cmd = chars[i]; i += 1
        } else {
            cmd = lastCmd
            if cmd == "M" { cmd = "L" }
            if cmd == "m" { cmd = "l" }
        }
        lastCmd = cmd

        switch cmd {
        case "M":
            let x = parseNumber(); let y = parseNumber()
            path.move(to: CGPoint(x: x, y: y))
            currentX = x; currentY = y
        case "m":
            let dx = parseNumber(); let dy = parseNumber()
            currentX += dx; currentY += dy
            path.move(to: CGPoint(x: currentX, y: currentY))
        case "L":
            let x = parseNumber(); let y = parseNumber()
            path.addLine(to: CGPoint(x: x, y: y))
            currentX = x; currentY = y
        case "l":
            let dx = parseNumber(); let dy = parseNumber()
            currentX += dx; currentY += dy
            path.addLine(to: CGPoint(x: currentX, y: currentY))
        case "H":
            currentX = parseNumber()
            path.addLine(to: CGPoint(x: currentX, y: currentY))
        case "h":
            currentX += parseNumber()
            path.addLine(to: CGPoint(x: currentX, y: currentY))
        case "V":
            currentY = parseNumber()
            path.addLine(to: CGPoint(x: currentX, y: currentY))
        case "v":
            currentY += parseNumber()
            path.addLine(to: CGPoint(x: currentX, y: currentY))
        case "C":
            let x1 = parseNumber(); let y1 = parseNumber()
            let x2 = parseNumber(); let y2 = parseNumber()
            let x = parseNumber(); let y = parseNumber()
            path.addCurve(to: CGPoint(x: x, y: y),
                          control1: CGPoint(x: x1, y: y1),
                          control2: CGPoint(x: x2, y: y2))
            currentX = x; currentY = y
        case "c":
            let dx1 = parseNumber(); let dy1 = parseNumber()
            let dx2 = parseNumber(); let dy2 = parseNumber()
            let dx = parseNumber(); let dy = parseNumber()
            path.addCurve(to: CGPoint(x: currentX + dx, y: currentY + dy),
                          control1: CGPoint(x: currentX + dx1, y: currentY + dy1),
                          control2: CGPoint(x: currentX + dx2, y: currentY + dy2))
            currentX += dx; currentY += dy
        case "Q":
            let x1 = parseNumber(); let y1 = parseNumber()
            let x = parseNumber(); let y = parseNumber()
            path.addQuadCurve(to: CGPoint(x: x, y: y),
                              control: CGPoint(x: x1, y: y1))
            currentX = x; currentY = y
        case "q":
            let dx1 = parseNumber(); let dy1 = parseNumber()
            let dx = parseNumber(); let dy = parseNumber()
            path.addQuadCurve(to: CGPoint(x: currentX + dx, y: currentY + dy),
                              control: CGPoint(x: currentX + dx1, y: currentY + dy1))
            currentX += dx; currentY += dy
        case "Z", "z":
            path.closeSubpath()
        default:
            while i < chars.count && !chars[i].isLetter { i += 1 }
        }
    }
    return path
}

let size = 1024
let colorSpace = CGColorSpace(name: CGColorSpace.displayP3)!

guard let ctx = CGContext(
    data: nil, width: size, height: size,
    bitsPerComponent: 8, bytesPerRow: 0,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("Failed to create bitmap context") }

let s = CGFloat(size)

// Full-bleed opaque fill (no rounding). macOS Tahoe inspects edge pixel alpha:
// ≥ 253 → clean system-applied squircle clip; ≤ 252 → "icon jail" (gray border).
// A rounded rect leaves transparent corner pixels (alpha 0) triggering the jail.
// Ref: https://developer.apple.com/forums/thread/797971
ctx.setFillColor(fillColor)
ctx.fill(CGRect(x: 0, y: 0, width: s, height: s))

let svgPixelWidth = svgWidth * scale
let svgPixelHeight = svgHeight * scale

let offsetX = (s - svgPixelWidth) / 2.0 + txPoints
let offsetY = (s - svgPixelHeight) / 2.0 - tyPoints

ctx.saveGState()
ctx.translateBy(x: 0, y: s)
ctx.scaleBy(x: 1, y: -1)
ctx.translateBy(x: offsetX, y: offsetY)
ctx.scaleBy(x: scale, y: scale)
let vPath = parseSVGPath(pathData)
ctx.addPath(vPath)
ctx.setFillColor(.white)
ctx.fillPath()
ctx.restoreGState()

guard let image = ctx.makeImage() else { fatalError("Failed to create CGImage") }
let url = URL(fileURLWithPath: outputPath)
guard let dest = CGImageDestinationCreateWithURL(
    url as CFURL, UTType.png.identifier as CFString, 1, nil
) else { fatalError("Failed to create image destination") }
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("Failed to write PNG") }
SWIFT_SCRIPT

if [ ! -f "$MASTER_PNG" ]; then
    echo "generate-icon: failed to render master PNG" >&2
    exit 1
fi

for SIZE in 16 32 128 256 512; do
    DOUBLE=$((SIZE * 2))
    sips -z "$SIZE" "$SIZE" "$MASTER_PNG" --out "$ICONSET_DIR/icon_${SIZE}x${SIZE}.png" > /dev/null
    sips -z "$DOUBLE" "$DOUBLE" "$MASTER_PNG" --out "$ICONSET_DIR/icon_${SIZE}x${SIZE}@2x.png" > /dev/null
done

iconutil --convert icns --output "$OUTPUT_DIR/icon.icns" "$ICONSET_DIR"

echo "generate-icon: wrote $OUTPUT_DIR/icon.icns ($VELLUM_ENVIRONMENT)"

# Compile the Icon Composer .icon bundle into Assets.car so Finder/Dock can use
# the Liquid Glass icon on Tahoe and actool's rounded raster fallback on pre-Tahoe.
# The .icns above is a full-bleed square (required for Tahoe edge-alpha check) and
# serves as CFBundleIconFile fallback. Assets.car (CFBundleIconName) takes priority
# in Finder, providing proper rounded display on all macOS versions.
ICON_BUNDLE_DIR=$(mktemp -d)/AppIcon.icon
mkdir -p "$ICON_BUNDLE_DIR"
cp "$ICON_SOURCE_DIR/icon.json" "$ICON_BUNDLE_DIR/icon.json"
cp -R "$ICON_SOURCE_DIR/Assets" "$ICON_BUNDLE_DIR/Assets"

ACTOOL_MAX_ATTEMPTS=3
ACTOOL_SUCCESS=0
for attempt in $(seq 1 $ACTOOL_MAX_ATTEMPTS); do
    rm -f "$OUTPUT_DIR/Assets.car"
    if ACTOOL_OUTPUT=$(xcrun actool "$ICON_BUNDLE_DIR" \
        --compile "$OUTPUT_DIR" \
        --platform macosx \
        --minimum-deployment-target 15.0 \
        --app-icon AppIcon \
        --output-partial-info-plist /dev/null \
        2>&1); then
        ACTOOL_SUCCESS=1
        break
    fi
    if [ -f "$OUTPUT_DIR/Assets.car" ]; then
        echo "generate-icon: actool exited non-zero but Assets.car was produced on attempt $attempt; continuing."
        ACTOOL_SUCCESS=1
        break
    fi
    echo "generate-icon: actool attempt $attempt/$ACTOOL_MAX_ATTEMPTS failed; retrying."
done
rm -rf "$(dirname "$ICON_BUNDLE_DIR")"

if [ "$ACTOOL_SUCCESS" = "1" ]; then
    echo "generate-icon: wrote $OUTPUT_DIR/Assets.car ($VELLUM_ENVIRONMENT)"
else
    echo "generate-icon: actool failed to produce Assets.car after all attempts:" >&2
    echo "$ACTOOL_OUTPUT" >&2
    exit 1
fi
