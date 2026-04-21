import SwiftUI
import VellumAssistantShared

/// A suggestion shown inside `HomeSuggestionPillBar` — an icon + short label
/// pair the user can tap to seed a new conversation with ("have you tried…").
///
/// `label` is the short pill copy (what the user sees on the pill); `prompt`
/// is the full seed message routed into the daemon when the pill is tapped.
/// The two differ: a pill might say "Plan a trip" while the seed prompt is
/// "Help me plan my next vacation to Japan — flights, lodging, itinerary."
struct HomeSuggestion: Identifiable, Hashable {
    let id: String
    let icon: VIcon
    let label: String
    let prompt: String
}

extension HomeSuggestion {
    /// Bridge a wire-model `SuggestedPrompt` into the UI-facing
    /// `HomeSuggestion`. The icon string (a Lucide key, optionally
    /// prefixed with `lucide-`) is resolved against `VIcon`'s raw values;
    /// unknown/nil keys fall back to `.sparkles` so bad data never crashes.
    init(from wire: SuggestedPrompt) {
        self.id = wire.id
        self.icon = Self.resolveIcon(wire.icon)
        self.label = wire.label
        self.prompt = wire.prompt
    }

    /// Best-effort `VIcon` lookup for a Lucide key coming off the wire.
    /// Tries the prefixed form first (`lucide-mail`), then the bare form
    /// (`mail` ↦ `lucide-mail`), then falls back to `.sparkles`. Matches
    /// the behavior described in the Home redesign plan for graceful
    /// handling of future server-added icons.
    private static func resolveIcon(_ key: String?) -> VIcon {
        guard let key, !key.isEmpty else { return .sparkles }
        if let icon = VIcon(rawValue: key) { return icon }
        if !key.hasPrefix("lucide-"),
           let icon = VIcon(rawValue: "lucide-\(key)") {
            return icon
        }
        return .sparkles
    }
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
            .padding(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: VSpacing.md))
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
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
    }
}
