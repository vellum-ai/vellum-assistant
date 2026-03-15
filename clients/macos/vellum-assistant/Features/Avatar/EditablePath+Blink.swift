import CoreGraphics

extension EditablePath {
    /// Returns a new EditablePath with all Y coordinates collapsed toward the path's
    /// vertical center, simulating a closed eye. The `amount` parameter controls how
    /// much to close: 0.0 = fully open (no change), 1.0 = fully closed (all Y = center).
    ///
    /// Uses the path's bounding box to find the vertical center, then linearly
    /// interpolates each point's Y toward that center.
    func blinked(amount: CGFloat = 1.0) -> EditablePath {
        // Compute vertical bounds
        var minY: CGFloat = .greatestFiniteMagnitude
        var maxY: CGFloat = -.greatestFiniteMagnitude
        for element in elements {
            for point in element.allPoints {
                minY = min(minY, point.y)
                maxY = max(maxY, point.y)
            }
        }
        guard minY < maxY else { return self }
        let centerY = (minY + maxY) / 2

        let newElements = elements.map { element -> PathElement in
            element.squishingY(toward: centerY, amount: amount)
        }
        return EditablePath(elements: newElements)
    }
}

extension EditablePath.PathElement {
    /// All CGPoints contained in this element (for bounding-box computation).
    var allPoints: [CGPoint] {
        switch self {
        case .moveTo(let p): return [p]
        case .lineTo(let p): return [p]
        case .curveTo(let to, let c1, let c2): return [to, c1, c2]
        case .close: return []
        }
    }

    /// Returns a new element with Y coordinates interpolated toward `centerY`.
    func squishingY(toward centerY: CGFloat, amount: CGFloat) -> EditablePath.PathElement {
        func squish(_ p: CGPoint) -> CGPoint {
            CGPoint(x: p.x, y: p.y + (centerY - p.y) * amount)
        }
        switch self {
        case .moveTo(let p): return .moveTo(squish(p))
        case .lineTo(let p): return .lineTo(squish(p))
        case .curveTo(let to, let c1, let c2):
            return .curveTo(to: squish(to), control1: squish(c1), control2: squish(c2))
        case .close: return .close
        }
    }
}
