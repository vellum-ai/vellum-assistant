import AppKit

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

        // Draw eyes
        for eyePath in eyeStyle.paths {
            let parsed = parseSVGPath(eyePath.svgPath)
            let transformed = parsed.copy(using: &transform)!
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
