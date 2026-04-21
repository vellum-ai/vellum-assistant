#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Inline connection-status section for the Settings screen.
///
/// Composed into `SettingsView`'s `Form` so users can see their connection
/// status alongside their account information. The `@AppStorage`-backed keys
/// mirror the priority order in `GatewayHTTPClient.resolveConnection()`, so
/// the label displayed here always matches the URL the network layer will
/// actually use, and SwiftUI re-renders the section as soon as those keys
/// change (e.g. on logout) without depending on the gateway client to notice
/// its session is gone.
struct ConnectionInfoSection: View {
    @EnvironmentObject var clientProvider: ClientProvider

    // `@AppStorage` participates in SwiftUI's dependency tracking, so any
    // write to these UserDefaults keys invalidates this view on the same
    // run-loop pass. A plain `UserDefaults.standard.string(forKey:)` read
    // would require some other observed state to flip before re-rendering.
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
