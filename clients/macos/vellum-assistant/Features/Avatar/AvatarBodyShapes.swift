import CoreGraphics

enum AvatarBodyShape: String, CaseIterable, Identifiable {
    case blob, cloud, sprout, star, ghost, urchin, stack, flower, burst, ninja

    var id: String { rawValue }

    @MainActor var viewBox: CGSize {
        guard let def = AvatarComponentStore.shared.bodyShape(id: rawValue) else { return .zero }
        return CGSize(width: def.viewBox.width, height: def.viewBox.height)
    }

    /// Point within the viewBox where eyes should be centered — derived from each body's
    /// native eye style placement. Ninja has no native eye style so uses a manual estimate.
    @MainActor var faceCenter: CGPoint {
        guard let def = AvatarComponentStore.shared.bodyShape(id: rawValue) else { return .zero }
        return CGPoint(x: def.faceCenter.x, y: def.faceCenter.y)
    }

    @MainActor var svgPath: String {
        AvatarComponentStore.shared.bodyShape(id: rawValue)?.svgPath ?? ""
    }
}
