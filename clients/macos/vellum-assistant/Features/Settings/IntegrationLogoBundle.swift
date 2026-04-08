import SwiftUI
import VellumAssistantShared

/// Resolves bundled Simple Icons PDFs shipped inside the shared framework's
/// `Resources/IntegrationLogos/` directory. Returns `nil` for providers that
/// don't have a pre-bundled asset — callers should fall back to URL-based
/// rendering.
enum IntegrationLogoBundle {
    static func hasBundledLogo(providerKey: String) -> Bool {
        return bundledURL(providerKey: providerKey) != nil
    }

    static func bundledURL(providerKey: String) -> URL? {
        Bundle.vellumShared.url(
            forResource: providerKey,
            withExtension: "pdf",
            subdirectory: "IntegrationLogos"
        )
    }

    @ViewBuilder
    static func image(providerKey: String, size: CGFloat) -> some View {
        if let url = bundledURL(providerKey: providerKey),
           let nsImage = NSImage(contentsOf: url) {
            Image(nsImage: nsImage)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
        } else {
            EmptyView()
        }
    }
}
