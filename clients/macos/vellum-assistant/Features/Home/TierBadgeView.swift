import SwiftUI
import VellumAssistantShared

/// Tappable pill badge that shows the current `RelationshipTier` label and,
/// when expanded, reveals the next-tier hint underneath.
///
/// Tier 4 (`.inSync`) has no `nextTierHint`; in that case the expansion area
/// is hidden entirely and tapping is disabled (the pill renders as a static
/// label since there's nothing left to disclose).
///
/// All colors come from `VColor` design tokens, which are adaptive and
/// resolve to the right value automatically in light vs dark mode.
struct TierBadgeView: View {
    let tier: RelationshipTier

    @State private var isExpanded: Bool

    init(tier: RelationshipTier, initiallyExpanded: Bool = false) {
        self.tier = tier
        self._isExpanded = State(initialValue: initiallyExpanded)
    }

    private var hasHint: Bool { tier.nextTierHint != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            pill
            if isExpanded, let hint = tier.nextTierHint {
                Text(hint)
                    .font(.system(size: 12, weight: .regular))
                    .foregroundColor(VColor.contentSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 4)
                    .transition(
                        .move(edge: .top).combined(with: .opacity)
                    )
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.8), value: isExpanded)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Relationship tier"))
        .accessibilityValue(Text(tier.label))
        .accessibilityHint(hasHint ? Text("Reveals the hint for the next tier") : Text(""))
        .accessibilityAddTraits(hasHint ? .isButton : [])
        .accessibilityAction(named: Text(isExpanded ? "Collapse" : "Expand")) {
            toggle()
        }
    }

    private var pill: some View {
        Button(action: toggle) {
            HStack(spacing: 6) {
                Text(tier.label)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(VColor.contentDefault)
                if hasHint {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(VColor.contentTertiary)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(
                Capsule(style: .continuous)
                    .fill(VColor.surfaceActive)
            )
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(VColor.borderElement, lineWidth: 0.5)
            )
            .contentShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!hasHint)
    }

    private func toggle() {
        guard hasHint else { return }
        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
            isExpanded.toggle()
        }
    }
}

#Preview("All tiers — light/dark, collapsed/expanded") {
    HStack(alignment: .top, spacing: 0) {
        tierColumn(title: "Light", scheme: .light)
        tierColumn(title: "Dark", scheme: .dark)
    }
}

@ViewBuilder
private func tierColumn(title: String, scheme: ColorScheme) -> some View {
    VStack(alignment: .leading, spacing: 24) {
        Text(title)
            .font(.caption)
            .foregroundColor(VColor.contentSecondary)
        ForEach(RelationshipTier.allCases, id: \.rawValue) { tier in
            VStack(alignment: .leading, spacing: 12) {
                Text("Tier \(tier.rawValue)")
                    .font(.caption2)
                    .foregroundColor(VColor.contentTertiary)
                TierBadgeView(tier: tier, initiallyExpanded: false)
                TierBadgeView(tier: tier, initiallyExpanded: true)
            }
        }
    }
    .padding(20)
    .frame(width: 320, alignment: .leading)
    .background(VColor.surfaceBase)
    .environment(\.colorScheme, scheme)
}
