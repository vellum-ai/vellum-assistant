import SwiftUI
import VellumAssistantShared

/// Renders an icon for an integration provider.
///
/// When `provider.logoURL` is non-nil, the image is fetched through
/// `VCachedRemoteImage` (which shares `VRemoteImageCache.session`) and the
/// initials avatar is shown as a placeholder while loading. When `logoURL`
/// is nil, the initials avatar is rendered directly.
///
/// The initials avatar uses the first two letters of the display name (or
/// provider key when the display name is missing) with a deterministic
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
    static func image(for provider: OAuthProviderMetadata, size: CGFloat = 24) -> some View {
        if let bundled = IntegrationLogoBundle.bundledImage(providerKey: provider.provider_key) {
            Image(nsImage: bundled)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
        } else if let url = provider.logoURL {
            VCachedRemoteImage(
                url: url,
                content: { image in
                    image
                        .resizable()
                        .interpolation(.high)
                        .aspectRatio(contentMode: .fit)
                },
                placeholder: {
                    initialsAvatar(
                        providerKey: provider.provider_key,
                        displayName: provider.display_name,
                        size: size
                    )
                }
            )
            .frame(width: size, height: size)
        } else {
            initialsAvatar(
                providerKey: provider.provider_key,
                displayName: provider.display_name,
                size: size
            )
        }
    }

    @ViewBuilder
    private static func initialsAvatar(providerKey: String, displayName: String?, size: CGFloat) -> some View {
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
