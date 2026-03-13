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

        // Draw eyes — remap from eye sourceViewBox to body viewBox using eye-center → face-center
        // alignment.  Each eye style's paths are designed around a center point within their source
        // coordinate space; each body shape defines a face-center where eyes should land.
        // Aspect-fit scaling sizes the eyes appropriately, then translation aligns the centers.
        // Per-combo overrides allow specific eye+body pairs to use a custom face center.
        let srcVB = eyeStyle.sourceViewBox
        let eyeCenter = eyeStyle.eyeCenter
        let overrideKey = "\(bodyShape.rawValue)-\(eyeStyle.rawValue)"
        let faceCenter = faceCenterOverrides[overrideKey] ?? bodyShape.faceCenter
        let remapScale = min(viewBox.width / srcVB.width, viewBox.height / srcVB.height)
        let remapTx = faceCenter.x - eyeCenter.x * remapScale
        let remapTy = faceCenter.y - eyeCenter.y * remapScale
        let remapT = CGAffineTransform(scaleX: remapScale, y: remapScale)
            .concatenating(CGAffineTransform(translationX: remapTx, y: remapTy))
        let eyeTransform = remapT.concatenating(transform)

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

    /// Renders only the body shape silhouette (no eyes) into an NSImage.
    static func renderBodyOnly(
        bodyShape: AvatarBodyShape,
        color: AvatarColor,
        size: CGFloat = 64
    ) -> NSImage {
        let cacheKey = "body-only-\(bodyShape.rawValue)-\(color.rawValue)-\(Int(size))"
        if let cached = cache[cacheKey] {
            return cached
        }

        let viewBox = bodyShape.viewBox
        let scale = min(size / viewBox.width, size / viewBox.height)
        let tx = (size - viewBox.width * scale) / 2
        let ty = (size - viewBox.height * scale) / 2

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

        let bodyPath = parseSVGPath(bodyShape.svgPath)
        let transformedBody = bodyPath.copy(using: &transform)!
        context.addPath(transformedBody)
        context.setFillColor(color.nsColor.cgColor)
        context.fillPath()

        image.unlockFocus()

        cache[cacheKey] = image
        return image
    }

    /// Renders only the eye paths (pupils + sclera) centered in an NSImage, no body shape.
    static func renderEyesOnly(
        eyeStyle: AvatarEyeStyle,
        size: CGFloat = 64
    ) -> NSImage {
        let cacheKey = "eyes-only-\(eyeStyle.rawValue)-\(Int(size))"
        if let cached = cache[cacheKey] {
            return cached
        }

        let srcVB = eyeStyle.sourceViewBox
        let scale = min(size / srcVB.width, size / srcVB.height)
        let tx = (size - srcVB.width * scale) / 2
        let ty = (size - srcVB.height * scale) / 2

        let baseTransform = CGAffineTransform(translationX: 0, y: size)
            .scaledBy(x: 1, y: -1)
            .translatedBy(x: tx, y: ty)
            .scaledBy(x: scale, y: scale)

        let image = NSImage(size: NSSize(width: size, height: size))
        image.lockFocus()
        guard let context = NSGraphicsContext.current?.cgContext else {
            image.unlockFocus()
            return image
        }

        for eyePath in eyeStyle.paths {
            let parsed = parseSVGPath(eyePath.svgPath)
            var mutableTransform = baseTransform
            let transformed = parsed.copy(using: &mutableTransform)!
            context.addPath(transformed)
            context.setFillColor(eyePath.color.cgColor)
            context.fillPath()
        }

        image.unlockFocus()

        cache[cacheKey] = image
        return image
    }

    /// Per-combo face-center overrides for when the default body faceCenter doesn't produce
    /// the best result for a specific eye style.  Key format: "bodyRawValue-eyeRawValue".
    ///
    /// Ghost (native faceCenter y=167, 28%) — non-native eyes pulled slightly lower to ~34%
    /// so they sit better within the ghost's rounded head rather than at the very top.
    ///
    /// Sprout (native faceCenter y=415, 66%) — non-native eyes pulled slightly higher to ~61%
    /// so they sit better within the sprout's leaf area rather than at the very bottom.
    private static let faceCenterOverrides: [String: CGPoint] = [
        // Ghost body — shift non-native eyes from y=167 → y=200
        "ghost-grumpy":  CGPoint(x: 321, y: 200),
        "ghost-angry":   CGPoint(x: 321, y: 200),
        "ghost-curious":  CGPoint(x: 321, y: 200),
        "ghost-goofy":   CGPoint(x: 321, y: 200),
        "ghost-bashful":  CGPoint(x: 321, y: 200),
        "ghost-gentle":  CGPoint(x: 321, y: 200),
        "ghost-quirky":  CGPoint(x: 321, y: 200),
        "ghost-dazed":   CGPoint(x: 321, y: 200),
        // Sprout body — shift non-native eyes from y=415 → y=385
        "sprout-grumpy":   CGPoint(x: 264, y: 385),
        "sprout-angry":    CGPoint(x: 264, y: 385),
        "sprout-goofy":    CGPoint(x: 264, y: 385),
        "sprout-surprised": CGPoint(x: 264, y: 385),
        "sprout-bashful":  CGPoint(x: 264, y: 385),
        "sprout-gentle":   CGPoint(x: 264, y: 385),
        "sprout-quirky":   CGPoint(x: 264, y: 385),
        "sprout-dazed":    CGPoint(x: 264, y: 385),
    ]

    private static var cache: [String: NSImage] = [:]
}
