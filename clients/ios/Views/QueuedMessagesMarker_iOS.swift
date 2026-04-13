#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// MARK: - Queued Messages Marker (iOS)

/// Inline transcript marker that stands in for one or more collapsed queued
/// user messages. Rendered in place of the individual queued bubbles —
/// the queued messages themselves are still listed in the queue drawer
/// (see `QueuedMessagesDrawer_iOS`), so showing them inline duplicates the
/// information and clutters the transcript when many follow-ups are queued.
///
/// Mirrors the macOS `QueuedMessagesMarker` visually (centered caption, same
/// tokens). Touch behavior is not applicable — the drawer owns cancel/edit
/// affordances for individual queued messages.
struct QueuedMessagesMarker_iOS: View {
    let count: Int

    var body: some View {
        HStack {
            Spacer()
            Text(label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            Spacer()
        }
        .padding(EdgeInsets(
            top: VSpacing.sm,
            leading: VSpacing.md,
            bottom: VSpacing.sm,
            trailing: VSpacing.md
        ))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }

    private var label: String {
        let noun = count == 1 ? "message" : "messages"
        return "\u{2014} \(count) \(noun) queued \u{2014}"
    }
}
#endif
