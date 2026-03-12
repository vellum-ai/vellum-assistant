import AppKit
import VellumAssistantShared

/// A bundled preset avatar character ("little dude") that users can select
/// during onboarding or from the avatar management sheet.
struct PresetAvatar: Identifiable, Equatable {
    let name: String
    var id: String { name }

    /// Cached image loaded once from the resource bundle.
    var image: NSImage? { Self.imageCache[name] }

    /// Static cache so images are loaded from disk once, not on every view render.
    private static let imageCache: [String: NSImage] = {
        var cache: [String: NSImage] = [:]
        for name in allNames {
            if let url = ResourceBundle.bundle.url(forResource: name, withExtension: "png"),
               let image = NSImage(contentsOf: url) {
                cache[name] = image
            }
        }
        return cache
    }()

    private static let allNames = [
        "green-grump", "orange-cloud", "orange-sprout", "orange-star",
        "pink-ghost", "pink-spiky", "purple-blob", "purple-flower",
        "teal-spike", "yellow-ninja"
    ]

    static let all: [PresetAvatar] = allNames.map { PresetAvatar(name: $0) }

    static func random() -> PresetAvatar {
        all.randomElement()!
    }
}
