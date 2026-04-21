#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Inline connection-status section for the Settings screen.
///
/// Rendered directly inside `SettingsView`'s `Form` — composed rather than
/// pushed — so users can see their connection status alongside their account
/// information without drilling into a subscreen. The `@AppStorage`-backed
/// keys mirror the priority order in `GatewayHTTPClient.resolveConnection()`
/// so the label displayed here always matches the URL the network layer will
/// actually use, and SwiftUI re-renders the section immediately when those
/// keys are cleared (e.g. on logout) instead of waiting for the underlying
/// connection client to notice.
struct ConnectionInfoSection: View {
    @EnvironmentObject var clientProvider: ClientProvider

    // `@AppStorage` participates in SwiftUI's dependency tracking, so writes
    // from `AuthManager.logout()` invalidate this view on the same run-loop
    // pass that clears the keys. Reading UserDefaults directly would require
    // waiting for some other piece of observed state (e.g. the gateway client
    // finally noticing its session is dead) to re-render the row.
    @AppStorage(UserDefaultsKeys.managedAssistantId) private var managedAssistantId: String = ""
    @AppStorage(UserDefaultsKeys.managedPlatformBaseURL) private var managedPlatformBaseURL: String = ""
    @AppStorage(UserDefaultsKeys.gatewayBaseURL) private var gatewayBaseURL: String = ""

    /// Describes which UserDefaults key populated the current connection, so
    /// the status row can label the URL appropriately. Mirrors the branches of
    /// `GatewayHTTPClient.resolveConnection()` on iOS.
    private enum ConnectionSource {
        case managedPlatform
        case gateway
    }

    /// The URL and source backing the current iOS connection, resolved in the
    /// same priority order as `GatewayHTTPClient.resolveConnection()`:
    /// managed platform first, then legacy `gateway_base_url` as a fallback.
    private var resolvedConnection: (url: String, source: ConnectionSource)? {
        if !managedAssistantId.isEmpty, !managedPlatformBaseURL.isEmpty {
            return (managedPlatformBaseURL, .managedPlatform)
        }
        if !gatewayBaseURL.isEmpty {
            return (gatewayBaseURL, .gateway)
        }
        return nil
    }

    var body: some View {
        Section("Connection") {
            if let connection = resolvedConnection {
                if clientProvider.isConnected {
                    HStack {
                        VIconView(.circleCheck, size: 16)
                            .foregroundStyle(VColor.systemPositiveStrong)
                        Text("Connected")
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentDefault)
                    }
                } else {
                    HStack {
                        VIconView(.circleAlert, size: 16)
                            .foregroundStyle(VColor.systemNegativeStrong)
                        Text("Disconnected")
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentDefault)
                    }
                }
                HStack {
                    Text(connection.source == .managedPlatform ? "Platform" : "Gateway")
                        .foregroundStyle(VColor.contentSecondary)
                    Spacer()
                    Text(connection.url)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            } else {
                // No managed bootstrap and no legacy gateway URL on disk.
                Text("Sign in with your Vellum account to connect.")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
            }
        }
    }
}
#endif
