import SwiftUI
import VellumAssistantShared

/// A suggestion shown inside `HomeSuggestionPillBar` — an icon + short label
/// pair the user can tap to seed a new conversation with ("have you tried…").
struct HomeSuggestion: Identifiable, Hashable {
    let id: String
    let icon: VIcon
    let label: String
}

/// A single dark-capsule pill with a leading circular icon badge and an
/// emphasised label. Private because nothing outside this file needs to
/// compose it directly — `HomeSuggestionPillBar` is the only caller.
private struct HomeSuggestionPill: View {
    let suggestion: HomeSuggestion
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .center, spacing: VSpacing.xs) {
                ZStack {
                    Circle()
                        .fill(VColor.surfaceActive)
                        .frame(width: 26, height: 26)
                    VIconView(suggestion.icon, size: 9)
                        .foregroundStyle(VColor.contentDefault)
                }

                Text(suggestion.label)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentDefault)
            }
            .padding(.leading, 4)
            .padding(.trailing, VSpacing.md)
            .padding(.vertical, 4)
            .background(Capsule().fill(VColor.surfaceActive))
        }
        .buttonStyle(.plain)
        .pointerCursor()
    }
}

/// Dismissible "by the way, have you tried…" container shown on the Home
/// page. Renders a headline + dismiss affordance on top and a horizontal
/// row of suggestion pills below. Robust to an empty `suggestions` array
/// (renders no pills).
struct HomeSuggestionPillBar: View {
    let headline: String
    let suggestions: [HomeSuggestion]
    let onSelect: (HomeSuggestion) -> Void
    let onDismiss: () -> Void

    var body: some View {
        // NOTE: Mock shows a 16pt outlined container. VRadius.lg is 12pt in
        // this token set, so we use VRadius.xl (=16) as the closest
        // existing equivalent. Same for VSpacing.lg (=16) vs VSpacing.md (=12).
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(alignment: .center, spacing: VSpacing.sm) {
                Text(headline)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentTertiary)

                Spacer()

                Button {
                    onDismiss()
                } label: {
                    VIconView(.x, size: 10)
                        .foregroundStyle(VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .pointerCursor()
                .accessibilityLabel(Text("Dismiss suggestions"))
            }

            if !suggestions.isEmpty {
                HStack(spacing: VSpacing.sm) {
                    ForEach(suggestions) { suggestion in
                        HomeSuggestionPill(suggestion: suggestion) {
                            onSelect(suggestion)
                        }
                    }
                }
            }
        }
        .padding(VSpacing.lg)
        .background(
            RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous)
                .fill(Color.clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
    }
}

#Preview("HomeSuggestionPillBar") {
    HomeSuggestionPillBar(
        headline: "By the way, have you tried one of these:",
        suggestions: [
            HomeSuggestion(id: "a", icon: .sparkles, label: "Summarize my inbox"),
            HomeSuggestion(id: "b", icon: .calendar, label: "Plan my week"),
            HomeSuggestion(id: "c", icon: .listChecks, label: "Draft a standup"),
        ],
        onSelect: { _ in },
        onDismiss: {}
    )
    .padding(32)
    .frame(width: 720)
    .background(VColor.surfaceBase)
}
