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
                    .foregroundStyle(VColor.contentSecondary)
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
        .accessibilityValue(Text(accessibilityValue))
        .accessibilityHint(hasHint ? Text("Reveals the hint for the next tier") : Text(""))
        .accessibilityAddTraits(hasHint ? .isButton : [])
        .accessibilityAction(named: Text(isExpanded ? "Collapse" : "Expand")) {
            toggle()
        }
    }

    private var accessibilityValue: String {
        if isExpanded, let hint = tier.nextTierHint {
            return "\(tier.label). \(hint)"
        }
        return tier.label
    }

    private var pill: some View {
        Button(action: toggle) {
            HStack(spacing: 6) {
                Text(tier.label)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(VColor.contentDefault)
                if hasHint {
                    VIconView(.chevronDown, size: 9)
                        .foregroundStyle(VColor.contentTertiary)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
            }
            .padding(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
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
