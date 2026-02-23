import AppKit
import SpriteKit

/// Converts pixel-art grids into SpriteKit textures using CGBitmapContext.
/// Each art pixel = `pixelSize` × `pixelSize` points. Uses `.nearest` filtering for crisp pixels.
enum PixelSpriteBuilder {

    // MARK: - Texture Building

    /// Renders a pixel grid into an SKTexture, optionally masked to specific pixels.
    /// - Parameters:
    ///   - grid: 2D array of UInt32? hex colors (nil = transparent).
    ///   - pixelSize: Points per art pixel.
    ///   - mask: Optional 2D array; only pixels where mask value matches `maskValue` are drawn.
    ///   - maskValue: The fragment index to include (used with mask).
    /// - Returns: Tuple of (texture, size in points).
    static func buildTexture(
        from grid: [[UInt32?]],
        pixelSize: CGFloat,
        mask: [[Int?]]? = nil,
        maskValue: Int? = nil
    ) -> (SKTexture, CGSize) {
        let rows = grid.count
        let cols = grid[0].count
        let width = Int(CGFloat(cols) * pixelSize)
        let height = Int(CGFloat(rows) * pixelSize)

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            let fallback = SKTexture()
            return (fallback, CGSize(width: width, height: height))
        }

        let ps = Int(pixelSize)

        for row in 0..<rows {
            for col in 0..<cols {
                guard let hex = grid[row][col] else { continue }

                // Apply mask filter
                if let mask, let maskValue {
                    guard mask[row][col] == maskValue else { continue }
                }

                let r = CGFloat((hex >> 16) & 0xFF) / 255.0
                let g = CGFloat((hex >> 8) & 0xFF) / 255.0
                let b = CGFloat(hex & 0xFF) / 255.0

                context.setFillColor(red: r, green: g, blue: b, alpha: 1.0)
                // CGContext Y is flipped (0 at bottom)
                let x = col * ps
                let y = (rows - 1 - row) * ps
                context.fill(CGRect(x: x, y: y, width: ps, height: ps))
            }
        }

        guard let cgImage = context.makeImage() else {
            return (SKTexture(), CGSize(width: width, height: height))
        }

        let texture = SKTexture(cgImage: cgImage)
        texture.filteringMode = .nearest
        return (texture, CGSize(width: width, height: height))
    }

    /// Builds an SKSpriteNode from a pixel grid.
    static func buildSprite(
        from grid: [[UInt32?]],
        pixelSize: CGFloat,
        mask: [[Int?]]? = nil,
        maskValue: Int? = nil
    ) -> SKSpriteNode {
        let (texture, size) = buildTexture(from: grid, pixelSize: pixelSize, mask: mask, maskValue: maskValue)
        let sprite = SKSpriteNode(texture: texture, size: size)
        return sprite
    }

    // MARK: - Egg Fragments

    struct FragmentInfo {
        let index: Int
        let sprite: SKSpriteNode
        /// Offset from the egg center to this fragment's visual center, in points.
        let centerOffset: CGPoint
    }

    /// Builds 7 egg fragment sprites, each masked to its fragment region.
    static func buildEggFragments(pixelSize: CGFloat) -> [FragmentInfo] {
        let grid = PixelArtData.egg
        let map = EggFragmentMap.fragmentMap
        let rows = grid.count
        let cols = grid[0].count

        var fragments: [FragmentInfo] = []

        for frag in 0..<7 {
            // Find bounding box of this fragment
            var minR = rows, maxR = 0, minC = cols, maxC = 0
            for r in 0..<rows {
                for c in 0..<cols {
                    if map[r][c] == frag {
                        minR = min(minR, r)
                        maxR = max(maxR, r)
                        minC = min(minC, c)
                        maxC = max(maxC, c)
                    }
                }
            }
            guard minR <= maxR, minC <= maxC else { continue }

            // Extract sub-grid for this fragment
            let subRows = maxR - minR + 1
            let subCols = maxC - minC + 1
            var subGrid = [[UInt32?]](repeating: [UInt32?](repeating: nil, count: subCols), count: subRows)
            for r in minR...maxR {
                for c in minC...maxC {
                    if map[r][c] == frag {
                        subGrid[r - minR][c - minC] = grid[r][c]
                    }
                }
            }

            let sprite = buildSprite(from: subGrid, pixelSize: pixelSize)

            // Compute offset from egg center to fragment center (in points)
            let eggCenterX = CGFloat(cols) * pixelSize / 2
            let eggCenterY = CGFloat(rows) * pixelSize / 2
            let fragCenterX = (CGFloat(minC) + CGFloat(subCols) / 2) * pixelSize
            let fragCenterY = (CGFloat(minR) + CGFloat(subRows) / 2) * pixelSize

            // SpriteKit Y is up, grid Y is down
            let offsetX = fragCenterX - eggCenterX
            let offsetY = eggCenterY - fragCenterY

            fragments.append(FragmentInfo(
                index: frag,
                sprite: sprite,
                centerOffset: CGPoint(x: offsetX, y: offsetY)
            ))
        }

        return fragments
    }

    // MARK: - NSImage for SwiftUI

    /// Builds an NSImage of the minimalist avatar face.
    /// Renders a warm tan blob with a dark outline, two eyes with white sclera
    /// and dark pupils. The `pixelSize` parameter controls overall scale.
    /// The `palette` parameter is accepted for API compatibility but the face uses
    /// fixed warm-neutral colors that work in both light and dark mode.
    static func buildBlobNSImage(pixelSize: CGFloat, palette: DinoPalette) -> NSImage {
        // Scale factor: the old blob grid was 26 wide, so nominal radius ~ 13 * pixelSize
        let nominalRadius = 13.0 * pixelSize
        // The blob path varies radius by up to +9% (sum of all harmonics)
        let maxVariation: CGFloat = 1.0 + 0.04 + 0.03 + 0.02  // 1.09
        let strokeWidth = max(1.5, pixelSize * 0.8)
        // Canvas must fit the maximum varied radius plus half the stroke (centered on path)
        let maxExtent = nominalRadius * maxVariation + strokeWidth / 2.0
        let canvasSide = ceil(maxExtent * 2.0) + 2  // +2 for a 1pt safety margin each side
        let size = NSSize(width: canvasSide, height: canvasSide)
        let image = NSImage(size: size)
        image.lockFocus()

        guard let context = NSGraphicsContext.current?.cgContext else {
            image.unlockFocus()
            return image
        }

        let centerX = size.width / 2.0
        let centerY = size.height / 2.0
        let blobRadius = nominalRadius

        // Build an organic blob path — slightly irregular ellipse
        let path = CGMutablePath()
        let segments = 64
        for i in 0..<segments {
            let angle = CGFloat(i) / CGFloat(segments) * 2.0 * .pi
            // Subtle radius variation for organic feel
            let variation: CGFloat = 1.0
                + 0.04 * cos(2.0 * angle + 0.3)
                + 0.03 * sin(3.0 * angle + 1.0)
                + 0.02 * cos(5.0 * angle)
            let r = blobRadius * variation
            let x = centerX + r * cos(angle)
            let y = centerY + r * sin(angle)
            if i == 0 {
                path.move(to: CGPoint(x: x, y: y))
            } else {
                path.addLine(to: CGPoint(x: x, y: y))
            }
        }
        path.closeSubpath()

        // Fill: warm tan (#E3DCB6)
        context.setFillColor(red: 0xE3 / 255.0, green: 0xDC / 255.0, blue: 0xB6 / 255.0, alpha: 1.0)
        context.addPath(path)
        context.fillPath()

        // Outline stroke: dark (#1C1917)
        context.setStrokeColor(red: 0x1C / 255.0, green: 0x19 / 255.0, blue: 0x17 / 255.0, alpha: 1.0)
        context.setLineWidth(max(1.5, pixelSize * 0.8))
        context.addPath(path)
        context.strokePath()

        // Eyes: white sclera with dark pupils
        let eyeOuterRadius = diameter * 0.10
        let pupilRadius = diameter * 0.055
        let eyeY = centerY + blobRadius * 0.08  // slightly above center
        let eyeSpacing = diameter * 0.18

        for sign: CGFloat in [-1.0, 1.0] {
            let ex = centerX + sign * eyeSpacing

            // White sclera
            context.setFillColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 1.0)
            context.fillEllipse(in: CGRect(
                x: ex - eyeOuterRadius,
                y: eyeY - eyeOuterRadius,
                width: eyeOuterRadius * 2,
                height: eyeOuterRadius * 2
            ))

            // Sclera outline
            context.setStrokeColor(red: 0x1C / 255.0, green: 0x19 / 255.0, blue: 0x17 / 255.0, alpha: 1.0)
            context.setLineWidth(max(0.8, pixelSize * 0.4))
            context.strokeEllipse(in: CGRect(
                x: ex - eyeOuterRadius,
                y: eyeY - eyeOuterRadius,
                width: eyeOuterRadius * 2,
                height: eyeOuterRadius * 2
            ))

            // Dark pupil
            context.setFillColor(red: 0x1C / 255.0, green: 0x19 / 255.0, blue: 0x17 / 255.0, alpha: 1.0)
            context.fillEllipse(in: CGRect(
                x: ex - pupilRadius,
                y: eyeY - pupilRadius,
                width: pupilRadius * 2,
                height: pupilRadius * 2
            ))
        }

        image.unlockFocus()
        return image
    }

    /// Renders any pixel grid into an NSImage.
    static func buildNSImage(from grid: [[UInt32?]], pixelSize: CGFloat) -> NSImage {
        let rows = grid.count
        let cols = grid[0].count
        let width = Int(CGFloat(cols) * pixelSize)
        let height = Int(CGFloat(rows) * pixelSize)

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return NSImage(size: NSSize(width: width, height: height))
        }

        let ps = Int(pixelSize)

        for row in 0..<rows {
            for col in 0..<cols {
                guard let hex = grid[row][col] else { continue }
                let r = CGFloat((hex >> 16) & 0xFF) / 255.0
                let g = CGFloat((hex >> 8) & 0xFF) / 255.0
                let b = CGFloat(hex & 0xFF) / 255.0
                context.setFillColor(red: r, green: g, blue: b, alpha: 1.0)
                let x = col * ps
                let y = (rows - 1 - row) * ps
                context.fill(CGRect(x: x, y: y, width: ps, height: ps))
            }
        }

        guard let cgImage = context.makeImage() else {
            return NSImage(size: NSSize(width: width, height: height))
        }

        return NSImage(cgImage: cgImage, size: NSSize(width: width, height: height))
    }
}
