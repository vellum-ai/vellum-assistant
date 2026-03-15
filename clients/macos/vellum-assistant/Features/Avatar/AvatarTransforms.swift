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

    /// Resolves the face center for a body/eye combination, checking the
    /// component store for per-combo overrides before falling back to the
    /// body's default.
    @MainActor static func resolveFaceCenter(
        bodyShape: AvatarBodyShape,
        eyeStyle: AvatarEyeStyle
    ) -> CGPoint {
        if let override = AvatarComponentStore.shared.faceCenterOverride(
            bodyId: bodyShape.rawValue,
            eyeId: eyeStyle.rawValue
        ) {
            return override
        }
        return bodyShape.faceCenter
    }
}
