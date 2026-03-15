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
