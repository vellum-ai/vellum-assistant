import SwiftUI
import AppKit

/// Live-rendered avatar using CAShapeLayer, enabling future animations
/// (blink, ripple, bounce). Renders identically to AvatarCompositor's
/// static bitmap output for the same body/eyes/color combination.
struct AnimatedAvatarView: View {
    let bodyShape: AvatarBodyShape
    let eyeStyle: AvatarEyeStyle
    let color: AvatarColor
    let size: CGFloat

    var body: some View {
        AvatarLayerRepresentable(bodyShape: bodyShape, eyeStyle: eyeStyle, color: color, size: size)
            .accessibilityHidden(true)
    }
}

private struct AvatarLayerRepresentable: NSViewRepresentable {
    let bodyShape: AvatarBodyShape
    let eyeStyle: AvatarEyeStyle
    let color: AvatarColor
    let size: CGFloat

    func makeNSView(context: Context) -> AvatarLayerView {
        let view = AvatarLayerView(frame: NSRect(x: 0, y: 0, width: size, height: size))
        view.configure(bodyShape: bodyShape, eyeStyle: eyeStyle, color: color, size: size)
        return view
    }

    func updateNSView(_ nsView: AvatarLayerView, context: Context) {
        nsView.configure(bodyShape: bodyShape, eyeStyle: eyeStyle, color: color, size: size)
    }
}

class AvatarLayerView: NSView {
    private var bodyLayer = CAShapeLayer()
    private var eyeLayers: [CAShapeLayer] = []

    /// Track current configuration to skip redundant updates.
    private var currentKey: String?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.addSublayer(bodyLayer)
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(bodyShape: AvatarBodyShape, eyeStyle: AvatarEyeStyle, color: AvatarColor, size: CGFloat) {
        let key = "\(bodyShape.rawValue)-\(eyeStyle.rawValue)-\(color.rawValue)-\(Int(size))"
        guard key != currentKey else { return }
        currentKey = key

        // Update frame
        frame = NSRect(x: 0, y: 0, width: size, height: size)

        // Disable implicit CALayer animations during configuration
        CATransaction.begin()
        CATransaction.setDisableActions(true)

        // --- Body layer ---
        let bodyTransform = AvatarTransforms.bodyTransform(viewBox: bodyShape.viewBox, outputSize: size)
        let bodyEditable = parseSVGPathToEditable(bodyShape.svgPath)
        let bodyCGPath = bodyEditable.toCGPath()

        var mutableTransform = bodyTransform
        bodyLayer.path = bodyCGPath.copy(using: &mutableTransform)
        bodyLayer.fillColor = color.nsColor.cgColor
        bodyLayer.frame = CGRect(x: 0, y: 0, width: size, height: size)

        // --- Eye layers ---
        // Remove old eye layers
        for layer in eyeLayers { layer.removeFromSuperlayer() }
        eyeLayers.removeAll()

        let faceCenter = AvatarTransforms.resolveFaceCenter(bodyShape: bodyShape, eyeStyle: eyeStyle)
        let eyeXform = AvatarTransforms.eyeTransform(
            eyeSourceViewBox: eyeStyle.sourceViewBox,
            eyeCenter: eyeStyle.eyeCenter,
            bodyViewBox: bodyShape.viewBox,
            faceCenter: faceCenter,
            bodyTransform: bodyTransform
        )

        for eyePath in eyeStyle.paths {
            let eyeEditable = parseSVGPathToEditable(eyePath.svgPath)
            let eyeCGPath = eyeEditable.toCGPath()
            var mutableEyeTransform = eyeXform
            let transformedEyePath = eyeCGPath.copy(using: &mutableEyeTransform)

            let eyeLayer = CAShapeLayer()
            eyeLayer.path = transformedEyePath
            eyeLayer.fillColor = eyePath.color.cgColor
            eyeLayer.frame = CGRect(x: 0, y: 0, width: size, height: size)
            layer?.addSublayer(eyeLayer)
            eyeLayers.append(eyeLayer)
        }

        CATransaction.commit()
    }
}
