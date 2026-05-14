import AppKit

@MainActor
enum SubagentAvatarProvider {
    private static var cache: [String: NSImage] = [:]

    static func avatar(for subagentId: String, size: CGFloat) -> NSImage {
        let cacheKey = "\(subagentId)-\(Int(size))"
        if let cached = cache[cacheKey] { return cached }

        let (body, eyes, color) = traits(for: subagentId)
        let image = AvatarCompositor.render(bodyShape: body, eyeStyle: eyes, color: color, size: size)
        cache[cacheKey] = image
        return image
    }

    static func traits(for id: String) -> (AvatarBodyShape, AvatarEyeStyle, AvatarColor) {
        var hasher = Hasher()
        hasher.combine(id)
        let hash = abs(hasher.finalize())
        let body = AvatarBodyShape.allCases[hash % AvatarBodyShape.allCases.count]
        let eyes = AvatarEyeStyle.allCases[(hash / 10) % AvatarEyeStyle.allCases.count]
        let color = AvatarColor.allCases[(hash / 100) % AvatarColor.allCases.count]
        return (body, eyes, color)
    }
}
