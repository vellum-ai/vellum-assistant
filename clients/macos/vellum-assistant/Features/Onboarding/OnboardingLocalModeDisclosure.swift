import VellumAssistantShared
import SwiftUI

/// Collapsible "Local Mode" disclosure that presents the privacy-first
/// alternative to the managed Vellum Cloud card. Copy is intentionally
/// framed positively — this is a first-class option, not a downgrade.
///
/// The parent owns `isExpanded` so the card's transition can be coordinated
/// with sibling animations.
@MainActor
internal struct OnboardingLocalModeDisclosure: View {
    @Binding var isExpanded: Bool

    var kicker: String = "LOCAL MODE"
    var title: String = "Continue without an account"
    var tradeoffs: [String] = [
        "No account — install and start chatting",
        "Your data stays on your Mac",
        "Bring your own API key",
    ]
    var secondaryCTA: String = "Continue locally"
    var isDisabled: Bool = false
    var onUseLocalMode: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header row: kicker + title on the left, expand/collapse button on the right.
            HStack(alignment: .top, spacing: VSpacing.sm) {
                Button {
                    withAnimation(VAnimation.fast) { isExpanded.toggle() }
                } label: {
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text(kicker)
                            .font(VFont.labelSmall)
                            .foregroundStyle(VColor.contentTertiary)
                            .textCase(.uppercase)
                            .tracking(0.6)
                        Text(title)
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentDefault)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Spacer(minLength: 0)

                VButton(
                    label: isExpanded ? "Collapse" : "Expand",
                    iconOnly: isExpanded ? VIcon.chevronUp.rawValue : VIcon.chevronDown.rawValue,
                    style: .outlined,
                    size: .pill,
                    iconColor: VColor.contentSecondary
                ) {
                    withAnimation(VAnimation.fast) { isExpanded.toggle() }
                }
            }

            if isExpanded {
                VStack(alignment: .leading, spacing: 0) {
                    Spacer().frame(height: VSpacing.sm)

                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        ForEach(tradeoffs, id: \.self) { item in
                            tradeoffRow(item)
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel(Text("Local Mode details"))

                    Spacer().frame(height: VSpacing.sm)

                    VButton(
                        label: secondaryCTA,
                        style: .outlined,
                        size: .pillRegular,
                        isFullWidth: true,
                        isDisabled: isDisabled
                    ) {
                        onUseLocalMode()
                    }
                }
                .transition(.opacity.combined(with: .offset(y: -4)))
            }
        }
        .padding(EdgeInsets(
            top: VSpacing.sm,
            leading: VSpacing.md,
            bottom: VSpacing.sm,
            trailing: VSpacing.sm
        ))
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg, style: .continuous)
                .fill(VColor.surfaceOverlay)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg, style: .continuous)
                .strokeBorder(VColor.borderBase, lineWidth: 1)
        )
    }

    @ViewBuilder
    private func tradeoffRow(_ text: String) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            VIconView(.circleCheck, size: 14)
                .foregroundStyle(VColor.systemPositiveStrong)
                .accessibilityHidden(true)
            Text(text)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentDefault)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(text))
    }
}
