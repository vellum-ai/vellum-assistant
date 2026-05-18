import SwiftUI
import VellumAssistantShared

/// Body component for credential/permission detail panels.
///
/// Reads structured fields from `FeedItem.metadata`:
///   - `provider` (String) — service provider name
///   - `accountInfo` (String?) — account identifier or email
///   - `status` (String?) — permission status (e.g. "active", "revoked", "expired", "degraded")
///   - `details` (String?) — additional context
///   - `missingScopes` ([String]?) — list of missing permission scopes
///
/// Falls back to `item.title` (or `summary` when title is nil) when metadata is absent.
struct HomePermissionDetailCard: View {
    let item: FeedItem

    // MARK: - Metadata accessors

    private var provider: String? {
        item.metadata?["provider"]?.value as? String
    }

    private var accountInfo: String? {
        item.metadata?["accountInfo"]?.value as? String
    }

    private var status: String? {
        item.metadata?["status"]?.value as? String
    }

    private var details: String? {
        item.metadata?["details"]?.value as? String
    }

    private var missingScopes: [String]? {
        guard let raw = item.metadata?["missingScopes"]?.value as? [Any?] else { return nil }
        let strings = raw.compactMap { $0 as? String }
        return strings.isEmpty ? nil : strings
    }

    /// Whether the metadata contains enough data to render the rich layout.
    private var hasStructuredData: Bool {
        provider != nil
    }

    // MARK: - Body

    var body: some View {
        if hasStructuredData {
            structuredContent
        } else {
            fallbackContent
        }
    }

    // MARK: - Structured layout

    private var structuredContent: some View {
        HStack {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                // Provider name
                Text(provider ?? "")
                    .font(VFont.titleMedium)
                    .foregroundStyle(VColor.contentDefault)

                // Account info
                if let account = accountInfo {
                    Text(account)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }

                // Status indicator
                if let statusText = status {
                    statusRow(statusText)
                }

                // Details text
                if let detailsText = details {
                    Text(detailsText)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                // Missing scopes list
                if let scopes = missingScopes, !scopes.isEmpty {
                    missingScopesList(scopes)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(VSpacing.lg)
    }

    // MARK: - Status row

    private func statusRow(_ text: String) -> some View {
        HStack(spacing: VSpacing.sm) {
            Circle()
                .fill(statusColor(for: text))
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)

            Text(text.capitalized)
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(statusColor(for: text))
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("Status: \(text)"))
    }

    /// Maps a status string to the appropriate color.
    ///
    /// "revoked" / "expired" → negative (red), "degraded" → warning (amber),
    /// everything else → secondary (muted).
    private func statusColor(for status: String) -> Color {
        switch status.lowercased() {
        case "revoked", "expired":
            return VColor.systemNegativeStrong
        case "degraded":
            return VColor.systemMidStrong
        default:
            return VColor.contentSecondary
        }
    }

    // MARK: - Missing scopes

    private func missingScopesList(_ scopes: [String]) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Missing Scopes")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
                .accessibilityAddTraits(.isHeader)

            ForEach(scopes, id: \.self) { scope in
                HStack(spacing: VSpacing.xs) {
                    Text("\u{2022}")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.systemNegativeStrong)
                        .accessibilityHidden(true)
                    Text(scope)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)
                }
            }
        }
    }

    // MARK: - Fallback

    private var fallbackContent: some View {
        Text(item.title ?? item.summary)
            .font(VFont.bodyMediumDefault)
            .foregroundStyle(VColor.contentSecondary)
            .padding(VSpacing.lg)
    }
}
