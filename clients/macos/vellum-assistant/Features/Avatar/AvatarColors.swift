import AppKit

enum AvatarColor: String, CaseIterable, Identifiable {
    case green, orange, pink, purple, teal, yellow

    var id: String { rawValue }

    @MainActor var nsColor: NSColor {
        guard let def = AvatarComponentStore.shared.color(id: rawValue) else { return .clear }
        return AvatarComponentStore.hexToNSColor(def.hex)
    }
}
