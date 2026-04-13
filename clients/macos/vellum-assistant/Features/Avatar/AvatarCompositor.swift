import AppKit
import VellumAssistantShared

@MainActor
enum AvatarCompositor {
    /// Renders a composite avatar from body shape + eye style + color into an NSImage.
    /// When `overrideBodyColor` is provided it replaces the avatar's own color for
    /// the body fill — useful for rendering a greyed-out failure state with a
    /// design-system token such as `VColor.contentDisabled`.
    static func render(
        bodyShape: AvatarBodyShape,
        eyeStyle: AvatarEyeStyle,
        color: AvatarColor,
        overrideBodyColor: NSColor? = nil,
        size: CGFloat = 512
    ) -> NSImage {
        let bodyNSColor = overrideBodyColor ?? color.nsColor
        let cacheKey = "\(bodyShape.rawValue)-\(eyeStyle.rawValue)-\(overrideBodyColor?.description ?? color.rawValue)-\(Int(size))"
        if let cached = cache[cacheKey] {
            return cached
        }

        let viewBox = bodyShape.viewBox
        guard viewBox.width > 0, viewBox.height > 0 else {
            return NSImage(size: NSSize(width: size, height: size))
        }

        let transform = AvatarTransforms.bodyTransform(viewBox: viewBox, outputSize: size)

        // Pre-parse SVG paths outside the drawing handler so they're computed once.
        let bodyPath = parseSVGPath(bodyShape.svgPath)
        let bodyColor = bodyNSColor.cgColor

        let faceCenter = AvatarTransforms.resolveFaceCenter(bodyShape: bodyShape, eyeStyle: eyeStyle)
        let eyeSourceViewBox = eyeStyle.sourceViewBox
        let eyeTransform: CGAffineTransform?
        let parsedEyePaths: [(CGPath, CGColor)]
        if eyeSourceViewBox.width > 0, eyeSourceViewBox.height > 0 {
            eyeTransform = AvatarTransforms.eyeTransform(
                eyeSourceViewBox: eyeSourceViewBox,
                eyeCenter: eyeStyle.eyeCenter,
                bodyViewBox: viewBox,
                faceCenter: faceCenter,
                bodyTransform: transform
            )
            parsedEyePaths = eyeStyle.paths.map { (parseSVGPath($0.svgPath), $0.color.cgColor) }
        } else {
            eyeTransform = nil
            parsedEyePaths = []
        }

        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }

            var bodyXform = transform
            if let transformedBody = bodyPath.copy(using: &bodyXform) {
                context.addPath(transformedBody)
                context.setFillColor(bodyColor)
                context.fillPath()
            }

            if let eyeXform = eyeTransform {
                for (parsed, eyeColor) in parsedEyePaths {
                    var mutableEyeXform = eyeXform
                    if let transformed = parsed.copy(using: &mutableEyeXform) {
                        context.addPath(transformed)
                        context.setFillColor(eyeColor)
                        context.fillPath()
                    }
                }
            }

            return true
        }

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
        guard viewBox.width > 0, viewBox.height > 0 else {
            return NSImage(size: NSSize(width: size, height: size))
        }

        let transform = AvatarTransforms.bodyTransform(viewBox: viewBox, outputSize: size)
        let bodyPath = parseSVGPath(bodyShape.svgPath)
        let bodyColor = color.nsColor.cgColor

        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            var mutableTransform = transform
            if let transformedBody = bodyPath.copy(using: &mutableTransform) {
                context.addPath(transformedBody)
                context.setFillColor(bodyColor)
                context.fillPath()
            }
            return true
        }

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
        guard viewBox.width > 0, viewBox.height > 0 else {
            return NSImage(size: NSSize(width: size, height: size))
        }

        let inset: CGFloat = 2
        let drawSize = size - inset * 2
        let scale = min(drawSize / viewBox.width, drawSize / viewBox.height)
        let tx = inset + (drawSize - viewBox.width * scale) / 2
        let ty = inset + (drawSize - viewBox.height * scale) / 2

        let transform = CGAffineTransform(translationX: 0, y: size)
            .scaledBy(x: 1, y: -1)
            .translatedBy(x: tx, y: ty)
            .scaledBy(x: scale, y: scale)

        let bodyPath = parseSVGPath(bodyShape.svgPath)
        let fillColor = NSColor(VColor.auxWhite).cgColor
        let strokeColor = NSColor(VColor.auxBlack).cgColor

        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            var mutableTransform = transform
            if let transformedBody = bodyPath.copy(using: &mutableTransform) {
                context.addPath(transformedBody)
                context.setFillColor(fillColor)
                context.fillPath()

                // Re-transform for stroke (fillPath consumes the path)
                var strokeTransform = transform
                if let strokeBody = bodyPath.copy(using: &strokeTransform) {
                    context.addPath(strokeBody)
                    context.setStrokeColor(strokeColor)
                    context.setLineWidth(1.5)
                    context.strokePath()
                }
            }
            return true
        }

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
        guard srcVB.width > 0, srcVB.height > 0 else {
            return NSImage(size: NSSize(width: size, height: size))
        }

        let eyeCenter = eyeStyle.eyeCenter
        let scale = min(size / srcVB.width, size / srcVB.height)
        let tx = size / 2 - eyeCenter.x * scale
        let ty = size / 2 - eyeCenter.y * scale

        let baseTransform = CGAffineTransform(translationX: 0, y: size)
            .scaledBy(x: 1, y: -1)
            .translatedBy(x: tx, y: ty)
            .scaledBy(x: scale, y: scale)

        let parsedEyePaths = eyeStyle.paths.map { (parseSVGPath($0.svgPath), $0.color.cgColor) }

        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            for (parsed, eyeColor) in parsedEyePaths {
                var mutableTransform = baseTransform
                if let transformed = parsed.copy(using: &mutableTransform) {
                    context.addPath(transformed)
                    context.setFillColor(eyeColor)
                    context.fillPath()
                }
            }
            return true
        }

        cache[cacheKey] = image
        return image
    }

    private static var cache: [String: NSImage] = [:]
}
