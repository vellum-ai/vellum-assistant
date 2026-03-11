import AppKit
import VellumAssistantShared

/// A bundled preset avatar character ("little dude") that users can select
/// during onboarding or from the avatar management sheet.
struct PresetAvatar: Identifiable, Equatable {
    let name: String
    var id: String { name }

    var image: NSImage? {
        guard let url = ResourceBundle.bundle.url(forResource: name, withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }

    static let all: [PresetAvatar] = [
        "green-grump", "orange-cloud", "orange-sprout", "orange-star",
        "pink-ghost", "pink-spiky", "purple-blob", "purple-flower",
        "teal-spike", "yellow-ninja"
    ].map { PresetAvatar(name: $0) }

    static func random() -> PresetAvatar {
        all.randomElement()!
    }
}
