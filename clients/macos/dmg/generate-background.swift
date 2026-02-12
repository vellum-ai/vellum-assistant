#!/usr/bin/env swift
// Generates the DMG installer background image using CoreGraphics.
// Usage: swift generate-background.swift [output-path]
// Output: A 1320x800 (Retina 2x) PNG suitable for a 660x400 DMG window.

import AppKit
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

let outputPath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "dmg-background@2x.png"

// --- Dimensions (2x Retina) ---
let width = 1320
let height = 800

// Icon centers at 2x (matching Finder positions: Vellum at 175,190 / Applications at 485,190)
let leftIconX = 175 * 2   // 350
let rightIconX = 485 * 2  // 970
let iconCenterY = 190 * 2 // 380

// --- Colors (Vellum brand: dark purple theme) ---
func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1.0) -> [CGFloat] {
    [r / 255.0, g / 255.0, b / 255.0, a]
}

let colorSpace = CGColorSpaceCreateDeviceRGB()

guard let ctx = CGContext(
    data: nil,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    fatalError("Failed to create bitmap context")
}

// Flip coordinate system so (0,0) is top-left (matching Finder coordinates)
ctx.translateBy(x: 0, y: CGFloat(height))
ctx.scaleBy(x: 1, y: -1)

// --- Background gradient ---
let gradientColors = [
    CGColor(colorSpace: colorSpace, components: rgb(22, 14, 36))!,   // Deep purple-black (top)
    CGColor(colorSpace: colorSpace, components: rgb(15, 10, 26))!,   // Even darker (bottom)
]
let gradient = CGGradient(
    colorsSpace: colorSpace,
    colors: gradientColors as CFArray,
    locations: [0.0, 1.0]
)!

ctx.drawLinearGradient(
    gradient,
    start: CGPoint(x: CGFloat(width) / 2, y: 0),
    end: CGPoint(x: CGFloat(width) / 2, y: CGFloat(height)),
    options: []
)

// --- Subtle radial glow behind each icon area ---
func drawGlow(centerX: Int, centerY: Int, radius: CGFloat, color: CGColor) {
    let clearColor = color.copy(alpha: 0)!
    let glowGradient = CGGradient(
        colorsSpace: colorSpace,
        colors: [color, clearColor] as CFArray,
        locations: [0.0, 1.0]
    )!
    ctx.drawRadialGradient(
        glowGradient,
        startCenter: CGPoint(x: CGFloat(centerX), y: CGFloat(centerY)),
        startRadius: 0,
        endCenter: CGPoint(x: CGFloat(centerX), y: CGFloat(centerY)),
        endRadius: radius,
        options: []
    )
}

// Purple glow behind Vellum icon
let purpleGlow = CGColor(colorSpace: colorSpace, components: rgb(88, 28, 135, 0.15))!
drawGlow(centerX: leftIconX, centerY: iconCenterY, radius: 200, color: purpleGlow)

// Lighter glow behind Applications icon
let blueGlow = CGColor(colorSpace: colorSpace, components: rgb(59, 34, 112, 0.12))!
drawGlow(centerX: rightIconX, centerY: iconCenterY, radius: 200, color: blueGlow)

// --- Arrow between icons ---
let arrowY = CGFloat(iconCenterY)
let arrowStartX = CGFloat(leftIconX + 130)  // Right of left icon
let arrowEndX = CGFloat(rightIconX - 130)    // Left of right icon
let arrowHeadSize: CGFloat = 20
let arrowLineWidth: CGFloat = 4.0

// Arrow color: muted purple-white
let arrowColor = CGColor(colorSpace: colorSpace, components: rgb(168, 140, 210, 0.7))!
ctx.setFillColor(arrowColor)

// Single filled polygon: shaft rectangle merging into arrowhead triangle
let shaftHalf: CGFloat = arrowLineWidth / 2
let neckX = arrowEndX - arrowHeadSize * 1.5  // Where shaft meets head

ctx.beginPath()
ctx.move(to: CGPoint(x: arrowStartX, y: arrowY - shaftHalf))          // top-left of shaft
ctx.addLine(to: CGPoint(x: neckX, y: arrowY - shaftHalf))             // top-right of shaft
ctx.addLine(to: CGPoint(x: neckX, y: arrowY - arrowHeadSize))         // top of arrowhead
ctx.addLine(to: CGPoint(x: arrowEndX, y: arrowY))                     // tip
ctx.addLine(to: CGPoint(x: neckX, y: arrowY + arrowHeadSize))         // bottom of arrowhead
ctx.addLine(to: CGPoint(x: neckX, y: arrowY + shaftHalf))             // bottom-right of shaft
ctx.addLine(to: CGPoint(x: arrowStartX, y: arrowY + shaftHalf))       // bottom-left of shaft
ctx.closePath()
ctx.fillPath()

// --- "Drag to install" text ---
let textY = CGFloat(iconCenterY + 150)  // Below the icons
let textCenterX = CGFloat(width) / 2.0

let textString = "Drag to Applications to install"
let fontSize: CGFloat = 28.0
let font = CTFontCreateWithName("Helvetica Neue" as CFString, fontSize, nil)
let textColor = CGColor(colorSpace: colorSpace, components: rgb(168, 140, 210, 0.5))!

let ctAttributes: [CFString: Any] = [
    kCTFontAttributeName: font,
    kCTForegroundColorAttributeName: textColor,
]
let attributedString = CFAttributedStringCreate(
    kCFAllocatorDefault,
    textString as CFString,
    ctAttributes as CFDictionary
)!
let line = CTLineCreateWithAttributedString(attributedString)
let textBounds = CTLineGetBoundsWithOptions(line, .useOpticalBounds)

// Position text centered horizontally
// Core Text draws in bottom-left origin, so undo our flip for text
ctx.saveGState()
ctx.translateBy(x: 0, y: CGFloat(height))
ctx.scaleBy(x: 1, y: -1)
// Now (0,0) is bottom-left, y increases upward
let textDrawY = CGFloat(height) - textY
let textDrawX = textCenterX - textBounds.width / 2
ctx.textPosition = CGPoint(x: textDrawX, y: textDrawY)
CTLineDraw(line, ctx)
ctx.restoreGState()

// --- Generate output ---
guard let image = ctx.makeImage() else {
    fatalError("Failed to create CGImage")
}

let url = URL(fileURLWithPath: outputPath)
guard let destination = CGImageDestinationCreateWithURL(
    url as CFURL,
    UTType.png.identifier as CFString,
    1,
    nil
) else {
    fatalError("Failed to create image destination at \(outputPath)")
}

let properties: [CFString: Any] = [
    kCGImagePropertyDPIWidth: 144,
    kCGImagePropertyDPIHeight: 144,
]
CGImageDestinationAddImage(destination, image, properties as CFDictionary)

guard CGImageDestinationFinalize(destination) else {
    fatalError("Failed to write PNG")
}

print("Generated DMG background: \(outputPath) (\(width)x\(height) @2x)")
