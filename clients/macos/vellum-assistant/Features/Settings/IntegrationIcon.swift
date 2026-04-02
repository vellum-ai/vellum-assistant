import SwiftUI
import VellumAssistantShared

/// Renders a colorful initials avatar for an integration provider.
/// Uses the first two letters of the display name with a deterministic
/// background color derived from the provider key.
enum IntegrationIcon {

    private static let palette: [Color] = [
        VColor.primaryBase,
        VColor.systemNegativeStrong,
        VColor.systemMidStrong,
        VColor.systemPositiveStrong,
        VColor.primaryHover,
        VColor.borderActive,
        VColor.contentSecondary,
        VColor.primaryActive,
    ]

    @ViewBuilder
    static func image(for providerKey: String, size: CGFloat = 24, displayName: String? = nil) -> some View {
        let name = displayName ?? providerKey
        let initials = String(name.prefix(2)).uppercased()
        let color = palette[Int(providerKey.utf8.reduce(0 as UInt32) { $0 &+ UInt32($1) }) % palette.count]

        ZStack {
            Circle()
                .fill(color)
            Text(initials)
                .font(.system(size: size * 0.4, weight: .semibold, design: .rounded))
                .foregroundStyle(VColor.auxWhite)
        }
        .frame(width: size, height: size)
    }
}
