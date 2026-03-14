import AppKit
import VellumAssistantShared

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
        let transform = AvatarTransforms.bodyTransform(viewBox: viewBox, outputSize: size)

        let image = NSImage(size: NSSize(width: size, height: size))
        image.lockFocus()
        guard let context = NSGraphicsContext.current?.cgContext else {
            image.unlockFocus()
            return image
        }

        // Draw body
        let bodyPath = parseSVGPath(bodyShape.svgPath)
        var mutableTransform = transform
        let transformedBody = bodyPath.copy(using: &mutableTransform)!
        context.addPath(transformedBody)
        context.setFillColor(color.nsColor.cgColor)
        context.fillPath()

        // Draw eyes — remap from eye sourceViewBox to body viewBox using eye-center → face-center
        // alignment.  Each eye style's paths are designed around a center point within their source
        // coordinate space; each body shape defines a face-center where eyes should land.
        // Aspect-fit scaling sizes the eyes appropriately, then translation aligns the centers.
        // Per-combo overrides allow specific eye+body pairs to use a custom face center.
        let faceCenter = AvatarTransforms.resolveFaceCenter(bodyShape: bodyShape, eyeStyle: eyeStyle)
        let eyeTransform = AvatarTransforms.eyeTransform(
            eyeSourceViewBox: eyeStyle.sourceViewBox,
            eyeCenter: eyeStyle.eyeCenter,
            bodyViewBox: viewBox,
            faceCenter: faceCenter,
            bodyTransform: transform
        )

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
        let transform = AvatarTransforms.bodyTransform(viewBox: viewBox, outputSize: size)

        let image = NSImage(size: NSSize(width: size, height: size))
        image.lockFocus()
        guard let context = NSGraphicsContext.current?.cgContext else {
            image.unlockFocus()
            return image
        }

        let bodyPath = parseSVGPath(bodyShape.svgPath)
        var mutableTransform = transform
        let transformedBody = bodyPath.copy(using: &mutableTransform)!
        context.addPath(transformedBody)
        context.setFillColor(color.nsColor.cgColor)
        context.fillPath()

        image.unlockFocus()

        cache[cacheKey] = image
        return image
    }

    /// Renders only the body shape outline (white fill, black stroke) into an NSImage.
    static func renderBodyOutline(
        bodyShape: AvatarBodyShape,
        size: CGFloat = 64
    ) -> NSImage {
        let cacheKey = "body-outline-\(bodyShape.rawValue)-\(Int(size))"
        if let cached = cache[cacheKey] {
            return cached
        }

        let viewBox = bodyShape.viewBox
        let inset: CGFloat = 2
        let drawSize = size - inset * 2
        let scale = min(drawSize / viewBox.width, drawSize / viewBox.height)
        let tx = inset + (drawSize - viewBox.width * scale) / 2
        let ty = inset + (drawSize - viewBox.height * scale) / 2

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
        context.setFillColor(NSColor(VColor.auxWhite).cgColor)
        context.fillPath()

        context.addPath(transformedBody)
        context.setStrokeColor(NSColor(VColor.auxBlack).cgColor)
        context.setLineWidth(1.5)
        context.strokePath()

        image.unlockFocus()

        cache[cacheKey] = image
        return image
    }

    /// Renders only the eye paths (pupils + sclera) centered in an NSImage, no body shape.
    /// Eyes are centered around their `eyeCenter` so they always appear in the middle of the image.
    static func renderEyesOnly(
        eyeStyle: AvatarEyeStyle,
        size: CGFloat = 64
    ) -> NSImage {
        let cacheKey = "eyes-only-\(eyeStyle.rawValue)-\(Int(size))"
        if let cached = cache[cacheKey] {
            return cached
        }

        let srcVB = eyeStyle.sourceViewBox
        let eyeCenter = eyeStyle.eyeCenter
        let scale = min(size / srcVB.width, size / srcVB.height)
        // Translate so that the eye center maps to the center of the output image.
        let tx = size / 2 - eyeCenter.x * scale
        let ty = size / 2 - eyeCenter.y * scale

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

    private static var cache: [String: NSImage] = [:]
}
