import SwiftUI
import VellumAssistantShared

/// Section header for time-bucketed feed groups (Today / Yesterday / Older).
///
/// Renders as a leading-aligned 12pt label using the shared design tokens
/// so it matches the Figma spec (#5A6672 / 12pt medium / leading aligned).
/// Intentionally pads nothing — the caller owns spacing around the header.
struct HomeFeedGroupHeader: View {
    let label: String

    var body: some View {
        Text(label)
            .font(VFont.bodySmallDefault)
            .foregroundStyle(VColor.contentSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}
