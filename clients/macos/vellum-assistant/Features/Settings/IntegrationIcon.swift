import SwiftUI
import VellumAssistantShared

/// Renders a colorful initials avatar for an integration provider.
/// Uses the first two letters of the display name with a deterministic
/// background color derived from the provider key.
enum IntegrationIcon {

    private static let palette: [Color] = [
        Color(hex: 0x18B07A),  // emerald
        Color(hex: 0xDA491A),  // red/danger
        Color(hex: 0xE8A020),  // gold
        Color(hex: 0x6366F1),  // indigo
        Color(hex: 0x8B5CF6),  // violet
        Color(hex: 0x0EA5E9),  // sky blue
        Color(hex: 0xEC4899),  // pink
        Color(hex: 0x14B8A6),  // teal
    ]

    @ViewBuilder
    static func image(for providerKey: String, size: CGFloat = 24, displayName: String? = nil) -> some View {
        let name = displayName ?? providerKey
        let initials = String(name.prefix(2)).uppercased()
        let color = palette[abs(providerKey.hashValue) % palette.count]

        ZStack {
            Circle()
                .fill(color)
            Text(initials)
                .font(.system(size: size * 0.4, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
    }
}
