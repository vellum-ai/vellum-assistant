#!/usr/bin/env swift
// Generates the DMG installer background image using CoreGraphics.
// Usage: swift generate-background.swift [output-path]
// Output: A 1320x1000 (Retina 2x) PNG suitable for a 660x500 DMG window.
//
// The background matches the Vellum onboarding style: warm cream surface
// with the character illustration strip along the bottom edge.

import AppKit
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

let scriptDir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().path

let outputPath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "dmg-background@2x.png"

// --- Dimensions (2x Retina) ---
let width = 1320
let height = 1000

// Icon centers at 2x — centered in 660px window: 200 and 460, midpoint = 330 = center
let leftIconX = 200 * 2   // 400
let rightIconX = 460 * 2  // 920
let iconCenterY = 200 * 2 // 400

// --- Colors (Vellum onboarding: warm cream surface) ---
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

// --- Background: warm cream gradient matching onboarding surfaceOverlay ---
// surfaceOverlay light = #F5F3EB, surfaceBase light = #E8E6DA
let gradientColors = [
    CGColor(colorSpace: colorSpace, components: rgb(245, 243, 235))!, // #F5F3EB (top)
    CGColor(colorSpace: colorSpace, components: rgb(236, 233, 222))!, // Slightly warmer (bottom)
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

// Warm white glow behind icon areas
let warmGlow = CGColor(colorSpace: colorSpace, components: rgb(255, 255, 255, 0.35))!
drawGlow(centerX: leftIconX, centerY: iconCenterY, radius: 180, color: warmGlow)
drawGlow(centerX: rightIconX, centerY: iconCenterY, radius: 180, color: warmGlow)

// --- Arrow between icons ---
let arrowY = CGFloat(iconCenterY)
let arrowStartX = CGFloat(leftIconX + 130)  // Right of left icon
let arrowEndX = CGFloat(rightIconX - 130)    // Left of right icon
let arrowHeadSize: CGFloat = 18
let arrowLineWidth: CGFloat = 3.0

// Arrow color: warm brown/olive to match the cream palette
let arrowColor = CGColor(colorSpace: colorSpace, components: rgb(140, 130, 100, 0.4))!
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

// --- Load DM Sans font from the project Resources ---
func loadFont(from path: String, size: CGFloat) -> CTFont? {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let fontDescriptors = CTFontManagerCreateFontDescriptorsFromURL(url) as? [CTFontDescriptor],
          let descriptor = fontDescriptors.first else {
        return nil
    }
    return CTFontCreateWithFontDescriptor(descriptor, size, nil)
}

// VFont.titleMedium = DM Sans weight 400 (Regular), size 20pt → 40px at 2x
let fontSize: CGFloat = 40.0
let fontDir = scriptDir + "/../vellum-assistant/Resources/Fonts"
let dmSansFont = loadFont(from: fontDir + "/DMSans-SemiBold.ttf", size: fontSize)
    ?? CTFontCreateWithName("Helvetica Neue" as CFString, fontSize, nil) // fallback

// --- Helper to draw centered text ---
func drawCenteredText(_ text: String, centerX: CGFloat, y: CGFloat, font: CTFont, color: CGColor) {
    let attrs: [CFString: Any] = [
        kCTFontAttributeName: font,
        kCTForegroundColorAttributeName: color,
    ]
    let attrStr = CFAttributedStringCreate(kCFAllocatorDefault, text as CFString, attrs as CFDictionary)!
    let ctLine = CTLineCreateWithAttributedString(attrStr)
    let bounds = CTLineGetBoundsWithOptions(ctLine, .useOpticalBounds)

    ctx.saveGState()
    ctx.translateBy(x: 0, y: CGFloat(height))
    ctx.scaleBy(x: 1, y: -1)
    ctx.textPosition = CGPoint(x: centerX - bounds.width / 2, y: CGFloat(height) - y)
    CTLineDraw(ctLine, ctx)
    ctx.restoreGState()
}

// --- "Drag to install" text ---
let textY = CGFloat(iconCenterY + 140)  // Below the icons
// Warm dark color matching contentSecondary
let dragColor = CGColor(colorSpace: colorSpace, components: rgb(100, 95, 75, 0.55))!

drawCenteredText("Drag to install", centerX: CGFloat(width) / 2.0, y: textY, font: dmSansFont, color: dragColor)

// --- Draw characters image at the bottom ---
let charactersPath = scriptDir + "/../vellum-assistant/Resources/welcome-characters.png"
if let charactersData = NSData(contentsOfFile: charactersPath) as Data?,
   let imageSource = CGImageSourceCreateWithData(charactersData as CFData, nil),
   let charactersImage = CGImageSourceCreateImageAtIndex(imageSource, 0, nil) {

    let imgWidth = CGFloat(charactersImage.width)
    let imgHeight = CGFloat(charactersImage.height)
    let aspectRatio = imgWidth / imgHeight

    // Full width, positioned at the very bottom edge
    let drawWidth = CGFloat(width)
    let drawHeight = drawWidth / aspectRatio

    // Undo the flip for image drawing — position at bottom edge
    ctx.saveGState()
    ctx.translateBy(x: 0, y: CGFloat(height))
    ctx.scaleBy(x: 1, y: -1)
    ctx.draw(charactersImage, in: CGRect(x: 0, y: drawHeight * 0.05, width: drawWidth, height: drawHeight))
    ctx.restoreGState()
} else {
    print("Warning: Could not load welcome-characters.png from \(charactersPath)")
}

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
