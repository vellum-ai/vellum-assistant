import AppKit

@MainActor
enum AvatarCompositor {
    /// Renders a composite avatar from body shape + eye style + color into an NSImage.
    static func render(
        bodyShape: AvatarBodyShape,
        eyeStyle: AvatarEyeStyle,
        color: AvatarColor,
        size: CGFloat = 512
    ) -> NSImage {
        let cacheKey = "\(bodyShape.rawValue)-\(eyeStyle.rawValue)-\(color.rawValue)-\(Int(size))"
        if let cached = cache[cacheKey] {
            return cached
        }

        let viewBox = bodyShape.viewBox
        let scale = min(size / viewBox.width, size / viewBox.height)
        let tx = (size - viewBox.width * scale) / 2
        let ty = (size - viewBox.height * scale) / 2

        // Flip Y: Core Graphics has y=0 at bottom, SVG has y=0 at top.
        // Translate up by size, then scale y by -1, then apply the aspect-fit transform.
        var transform = CGAffineTransform(translationX: 0, y: size)
            .scaledBy(x: 1, y: -1)
            .translatedBy(x: tx, y: ty)
            .scaledBy(x: scale, y: scale)

        let image = NSImage(size: NSSize(width: size, height: size))
        image.lockFocus()
        guard let context = NSGraphicsContext.current?.cgContext else {
            image.unlockFocus()
            return image
        }

        // Draw body
        let bodyPath = parseSVGPath(bodyShape.svgPath)
        let transformedBody = bodyPath.copy(using: &transform)!
        context.addPath(transformedBody)
        context.setFillColor(color.nsColor.cgColor)
        context.fillPath()

        // Draw eyes — remap from eye sourceViewBox to body viewBox before applying canvas transform.
        // This aspect-fit centers the eye paths within the body's coordinate space so that
        // eye styles designed for one body shape render correctly on any other body shape.
        let srcVB = eyeStyle.sourceViewBox
        var eyeTransform: CGAffineTransform
        if srcVB.width == viewBox.width && srcVB.height == viewBox.height {
            // Same coordinate space — no remapping needed.
            eyeTransform = transform
        } else {
            let remapScale = min(viewBox.width / srcVB.width, viewBox.height / srcVB.height)
            let remapTx = (viewBox.width - srcVB.width * remapScale) / 2
            let remapTy = (viewBox.height - srcVB.height * remapScale) / 2
            // Remap: scale within body viewBox, then translate to center, then apply the canvas transform.
            let remapT = CGAffineTransform(scaleX: remapScale, y: remapScale)
                .concatenating(CGAffineTransform(translationX: remapTx, y: remapTy))
            eyeTransform = remapT.concatenating(transform)
        }

        for eyePath in eyeStyle.paths {
            let parsed = parseSVGPath(eyePath.svgPath)
            var mutableEyeTransform = eyeTransform
            let transformed = parsed.copy(using: &mutableEyeTransform)!
            context.addPath(transformed)
            context.setFillColor(eyePath.color.cgColor)
            context.fillPath()
        }

        image.unlockFocus()

        cache[cacheKey] = image
        return image
    }

    private static var cache: [String: NSImage] = [:]
}
