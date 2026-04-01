import SwiftUI
import VellumAssistantShared

/// Maps OAuth provider keys to their brand icons.
/// Falls back to a generic VIcon for unknown providers.
enum IntegrationIcon {
    /// Returns a View for the given provider key.
    /// Uses bundled brand assets when available, falls back to a Lucide icon.
    @ViewBuilder
    static func image(for providerKey: String, size: CGFloat = 24) -> some View {
        switch providerKey {
        case "google":
            Image("integration-google", bundle: .main)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
        case "microsoft":
            Image("integration-microsoft", bundle: .main)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
        default:
            VIconView(.power, size: size)
        }
    }
}
