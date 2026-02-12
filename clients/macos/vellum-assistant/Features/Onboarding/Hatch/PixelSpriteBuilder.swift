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

    /// Builds an NSImage of the dino pixel art for use in SwiftUI views.
    static func buildDinoNSImage(pixelSize: CGFloat) -> NSImage {
        let grid = PixelArtData.dino
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
