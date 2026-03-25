import CoreGraphics

/// Mutable intermediate representation of an SVG path, preserving individual
/// path elements so they can be manipulated programmatically (e.g., squishing
/// Y coordinates for blink animations, perturbing control points for ripples).
struct EditablePath {
    var elements: [PathElement]

    enum PathElement {
        case moveTo(CGPoint)
        case lineTo(CGPoint)
        case curveTo(to: CGPoint, control1: CGPoint, control2: CGPoint)
        case close
    }

    /// Returns a copy with all points scaled toward/away from the path's center
    /// by a sine-wave factor that varies by angle. Creates an organic squish/bulge
    /// effect — some regions expand while others contract, like a water balloon.
    ///
    /// `seed` selects a different wave phase; `amount` controls max scale deviation
    /// (e.g. 0.04 means ±4% radial scaling). All points (endpoints AND control
    /// handles) are scaled by the same factor at their position, preserving curve
    /// smoothness and ensuring the path stays closed with no gaps.
    func wobbled(seed: Int, amount: CGFloat) -> EditablePath {
        // Compute centroid of on-curve points
        var allPoints: [CGPoint] = []
        for element in elements {
            switch element {
            case .moveTo(let pt): allPoints.append(pt)
            case .lineTo(let pt): allPoints.append(pt)
            case .curveTo(let to, _, _): allPoints.append(to)
            case .close: break
            }
        }
        guard !allPoints.isEmpty else { return self }
        let cx = allPoints.map(\.x).reduce(0, +) / CGFloat(allPoints.count)
        let cy = allPoints.map(\.y).reduce(0, +) / CGFloat(allPoints.count)
        let center = CGPoint(x: cx, y: cy)
        let phase = Double(seed) * 1.1

        var result = elements
        for i in result.indices {
            switch result[i] {
            case .moveTo(let pt):
                result[i] = .moveTo(scaleFromCenter(pt, center: center, phase: phase, amount: amount))
            case .lineTo(let pt):
                result[i] = .lineTo(scaleFromCenter(pt, center: center, phase: phase, amount: amount))
            case .curveTo(let to, let c1, let c2):
                result[i] = .curveTo(
                    to: scaleFromCenter(to, center: center, phase: phase, amount: amount),
                    control1: scaleFromCenter(c1, center: center, phase: phase, amount: amount),
                    control2: scaleFromCenter(c2, center: center, phase: phase, amount: amount)
                )
            case .close:
                break
            }
        }
        return EditablePath(elements: result)
    }

    /// Scale a point toward/away from center by an angle-dependent factor.
    /// The sine wave creates regions that bulge outward and others that
    /// compress inward, producing a smooth, organic squish.
    private func scaleFromCenter(_ pt: CGPoint, center: CGPoint,
                                 phase: Double, amount: CGFloat) -> CGPoint {
        let dx = Double(pt.x - center.x)
        let dy = Double(pt.y - center.y)
        let angle = atan2(dy, dx)

        // Sine wave varies the scale factor by angle around the shape.
        // Using 2 harmonics creates a more interesting, less uniform wobble.
        let wave = sin(angle * 2.0 + phase) * 0.7 + sin(angle * 3.0 - phase * 0.5) * 0.3
        let scale = 1.0 + wave * Double(amount)

        return CGPoint(
            x: center.x + CGFloat(dx * scale),
            y: center.y + CGFloat(dy * scale)
        )
    }

    /// Convert to a Core Graphics path for rendering.
    func toCGPath() -> CGPath {
        let path = CGMutablePath()
        for element in elements {
            switch element {
            case .moveTo(let point):
                path.move(to: point)
            case .lineTo(let point):
                path.addLine(to: point)
            case .curveTo(let to, let control1, let control2):
                path.addCurve(to: to, control1: control1, control2: control2)
            case .close:
                path.closeSubpath()
            }
        }
        return path
    }
}
