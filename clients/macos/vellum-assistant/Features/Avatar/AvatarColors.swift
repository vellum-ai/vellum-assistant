import AppKit

enum AvatarColor: String, CaseIterable, Identifiable {
    case green, orange, pink, purple, teal, yellow

    var id: String { rawValue }

    var nsColor: NSColor {
        switch self {
        case .green: // color-literal-ok
            return NSColor(srgbRed: 0x4C / 255.0, green: 0x9B / 255.0, blue: 0x50 / 255.0, alpha: 1)
        case .orange: // color-literal-ok
            return NSColor(srgbRed: 0xE9 / 255.0, green: 0x64 / 255.0, blue: 0x2F / 255.0, alpha: 1)
        case .pink:
            return NSColor(srgbRed: 0xDB / 255.0, green: 0x4B / 255.0, blue: 0x77 / 255.0, alpha: 1)
        case .purple:
            return NSColor(srgbRed: 0xA6 / 255.0, green: 0x65 / 255.0, blue: 0xC9 / 255.0, alpha: 1)
        case .teal:
            return NSColor(srgbRed: 0x0E / 255.0, green: 0x9B / 255.0, blue: 0x8B / 255.0, alpha: 1)
        case .yellow: // color-literal-ok
            return NSColor(srgbRed: 0xE9 / 255.0, green: 0xC9 / 255.0, blue: 0x1A / 255.0, alpha: 1)
        }
    }
}
