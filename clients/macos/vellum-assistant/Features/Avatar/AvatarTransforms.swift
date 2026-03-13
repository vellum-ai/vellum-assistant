import CoreGraphics

/// Pure functions for computing the affine transforms used to render avatar
/// body shapes and eye paths. Shared by both AvatarCompositor (static bitmap)
/// and AnimatedAvatarView (live CAShapeLayer rendering).
enum AvatarTransforms {
    /// Computes the transform that maps an SVG viewBox to a square output of
    /// the given size: Y-flip (SVG y=0 at top, CG y=0 at bottom) + aspect-fit
    /// centering.
    static func bodyTransform(viewBox: CGSize, outputSize: CGFloat) -> CGAffineTransform {
        let scale = min(outputSize / viewBox.width, outputSize / viewBox.height)
        let tx = (outputSize - viewBox.width * scale) / 2
        let ty = (outputSize - viewBox.height * scale) / 2
        return CGAffineTransform(translationX: 0, y: outputSize)
            .scaledBy(x: 1, y: -1)
            .translatedBy(x: tx, y: ty)
            .scaledBy(x: scale, y: scale)
    }

    /// Computes the transform for eye paths: remaps from the eye's source
    /// viewBox to the body's viewBox using eye-center -> face-center alignment,
    /// then composes with the body transform.
    static func eyeTransform(
        eyeSourceViewBox: CGSize,
        eyeCenter: CGPoint,
        bodyViewBox: CGSize,
        faceCenter: CGPoint,
        bodyTransform: CGAffineTransform
    ) -> CGAffineTransform {
        let remapScale = min(bodyViewBox.width / eyeSourceViewBox.width,
                             bodyViewBox.height / eyeSourceViewBox.height)
        let remapTx = faceCenter.x - eyeCenter.x * remapScale
        let remapTy = faceCenter.y - eyeCenter.y * remapScale
        let remapT = CGAffineTransform(scaleX: remapScale, y: remapScale)
            .concatenating(CGAffineTransform(translationX: remapTx, y: remapTy))
        return remapT.concatenating(bodyTransform)
    }

    /// Resolves the face center for a body/eye combination, checking for
    /// per-combo overrides before falling back to the body's default.
    static func resolveFaceCenter(
        bodyShape: AvatarBodyShape,
        eyeStyle: AvatarEyeStyle
    ) -> CGPoint {
        let key = "\(bodyShape.rawValue)-\(eyeStyle.rawValue)"
        return faceCenterOverrides[key] ?? bodyShape.faceCenter
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
        // Ghost body — shift non-native eyes from y=167 -> y=200
        "ghost-grumpy":  CGPoint(x: 321, y: 200),
        "ghost-angry":   CGPoint(x: 321, y: 200),
        "ghost-curious":  CGPoint(x: 321, y: 200),
        "ghost-goofy":   CGPoint(x: 321, y: 200),
        "ghost-bashful":  CGPoint(x: 321, y: 200),
        "ghost-gentle":  CGPoint(x: 321, y: 200),
        "ghost-quirky":  CGPoint(x: 321, y: 200),
        "ghost-dazed":   CGPoint(x: 321, y: 200),
        // Sprout body — shift non-native eyes from y=415 -> y=385
        "sprout-grumpy":   CGPoint(x: 264, y: 385),
        "sprout-angry":    CGPoint(x: 264, y: 385),
        "sprout-goofy":    CGPoint(x: 264, y: 385),
        "sprout-surprised": CGPoint(x: 264, y: 385),
        "sprout-bashful":  CGPoint(x: 264, y: 385),
        "sprout-gentle":   CGPoint(x: 264, y: 385),
        "sprout-quirky":   CGPoint(x: 264, y: 385),
        "sprout-dazed":    CGPoint(x: 264, y: 385),
    ]
}
