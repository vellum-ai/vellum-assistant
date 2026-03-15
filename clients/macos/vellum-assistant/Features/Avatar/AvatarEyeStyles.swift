import AppKit

struct AvatarEyePath {
    let svgPath: String
    let color: NSColor
}

enum AvatarEyeStyle: String, CaseIterable, Identifiable {
    case grumpy, angry, curious, goofy, surprised, bashful, gentle, quirky, dazed

    var id: String { rawValue }

    @MainActor var sourceViewBox: CGSize {
        guard let def = AvatarComponentStore.shared.eyeStyle(id: rawValue) else { return .zero }
        return CGSize(width: def.sourceViewBox.width, height: def.sourceViewBox.height)
    }

    /// Approximate center of the combined eye paths' bounding box within sourceViewBox coordinates.
    /// Used by AvatarCompositor to align eyes to each body shape's face center.
    @MainActor var eyeCenter: CGPoint {
        guard let def = AvatarComponentStore.shared.eyeStyle(id: rawValue) else { return .zero }
        return CGPoint(x: def.eyeCenter.x, y: def.eyeCenter.y)
    }

    @MainActor var paths: [AvatarEyePath] {
        guard let def = AvatarComponentStore.shared.eyeStyle(id: rawValue) else { return [] }
        return def.paths.map { path in
            AvatarEyePath(
                svgPath: path.svgPath,
                color: AvatarComponentStore.hexToNSColor(path.color)
            )
        }
    }
}
