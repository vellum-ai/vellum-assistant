import SwiftUI
import VellumAssistantShared

/// Body component for updates-list detail panels.
///
/// Reads structured fields from `FeedItem.metadata`:
///   - `updates` ([[String: Any]]?) — array of update entries, each with:
///       - `title` (String) — update title
///       - `description` (String?) — update description
///       - `timestamp` (String?) — human-readable timestamp
///
/// Falls back to `item.summary` when no `updates` array is present,
/// or to `item.title` when metadata is entirely absent.
struct HomeUpdatesListDetailCard: View {
    let item: FeedItem

    // MARK: - Metadata accessors

    private var updates: [[String: Any]]? {
        guard let raw = item.metadata?["updates"]?.value as? [Any?] else { return nil }
        let dicts = raw.compactMap { ($0 as? [String: Any?])?.compactMapValues { $0 } }
        return dicts.isEmpty ? nil : dicts
    }

    // MARK: - Body

    var body: some View {
        if let entries = updates, !entries.isEmpty {
            updatesList(entries)
        } else if item.metadata != nil {
            summaryFallback
        } else {
            fallbackContent
        }
    }

    // MARK: - Updates list

    private func updatesList(_ entries: [[String: Any]]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(entries.enumerated()), id: \.offset) { index, entry in
                if index > 0 {
                    VColor.borderBase
                        .frame(height: 1)
                        .padding(.horizontal, VSpacing.lg)
                        .accessibilityHidden(true)
                }

                updateRow(entry)
            }
        }
    }

    private func updateRow(_ entry: [String: Any]) -> some View {
        let title = entry["title"] as? String ?? ""
        let description = entry["description"] as? String
        let timestamp = entry["timestamp"] as? String

        return VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentDefault)

                Spacer(minLength: VSpacing.sm)

                if let ts = timestamp {
                    Text(ts)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }

            if let desc = description, !desc.isEmpty {
                Text(desc)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(EdgeInsets(
            top: VSpacing.md,
            leading: VSpacing.lg,
            bottom: VSpacing.md,
            trailing: VSpacing.lg
        ))
    }

    // MARK: - Summary fallback

    /// When metadata exists but `updates` is absent, show the item summary
    /// as a single block of text.
    private var summaryFallback: some View {
        Text(item.summary)
            .font(VFont.bodyMediumDefault)
            .foregroundStyle(VColor.contentSecondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(VSpacing.lg)
    }

    // MARK: - Fallback

    private var fallbackContent: some View {
        Text(item.title)
            .font(VFont.bodyMediumDefault)
            .foregroundStyle(VColor.contentSecondary)
            .padding(VSpacing.lg)
    }
}
