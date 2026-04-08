import SwiftUI
import VellumAssistantShared

/// Resolves bundled Simple Icons PDFs shipped inside the shared framework's
/// `Resources/IntegrationLogos/` directory. Returns `nil` for providers that
/// don't have a pre-bundled asset OR when the asset cannot be decoded —
/// callers should treat `nil` as "fall through to the next rendering tier"
/// (URL-based logo, then initials fallback).
enum IntegrationLogoBundle {
    /// Loads and decodes the bundled asset for a provider. Returns `nil` when
    /// either the file doesn't exist in the bundle or `NSImage` fails to
    /// decode it (e.g. corrupt PDF). Checking presence + decode in a single
    /// call prevents a mismatch where `hasBundledLogo` says yes but the
    /// renderer silently returns EmptyView, breaking the fallback chain.
    static func bundledImage(providerKey: String) -> NSImage? {
        guard
            let url = Bundle.vellumShared.url(
                forResource: providerKey,
                withExtension: "pdf",
                subdirectory: "IntegrationLogos"
            )
        else {
            return nil
        }
        return NSImage(contentsOf: url)
    }
}
