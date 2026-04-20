import VellumAssistantShared
import SwiftUI

/// Collapsible "Advanced" disclosure that reveals Local Mode trade-offs and
/// a secondary "USE LOCAL MODE" call-to-action. Designed to live inside the
/// onboarding first step's setup cards.
///
/// The parent owns `isExpanded` so the card's transition can be coordinated
/// with sibling animations.
@MainActor
internal struct OnboardingLocalModeDisclosure: View {
    @Binding var isExpanded: Bool

    var kicker: String = "ADVANCED"
    var title: String = "Continue without an account (Local Mode)"
    var tradeoffsKicker: String = "TRADE-OFFS"
    var tradeoffs: [String] = [
        "Requires your own OpenAI API key",
        "Only awake when your Mac is active",
        "Available on this device only",
        "No cloud sync or automated backup",
    ]
    var secondaryCTA: String = "USE LOCAL MODE"
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
                            .font(VFont.bodyMediumEmphasised)
                            .foregroundStyle(VColor.contentDefault)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Spacer(minLength: 0)

                VButton(
                    label: isExpanded ? "Collapse" : "Expand",
                    iconOnly: isExpanded ? VIcon.x.rawValue : VIcon.plus.rawValue,
                    style: .outlined,
                    size: .pillRegular,
                    iconColor: VColor.contentSecondary
                ) {
                    withAnimation(VAnimation.fast) { isExpanded.toggle() }
                }
            }

            if isExpanded {
                VStack(alignment: .leading, spacing: 0) {
                    Spacer().frame(height: VSpacing.md)

                    VColor.borderBase
                        .frame(height: 1)
                        .accessibilityHidden(true)

                    Spacer().frame(height: VSpacing.md)

                    Text(tradeoffsKicker)
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.contentTertiary)
                        .textCase(.uppercase)
                        .tracking(0.6)

                    Spacer().frame(height: VSpacing.sm)

                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        ForEach(tradeoffs, id: \.self) { item in
                            tradeoffRow(item)
                        }
                    }

                    Spacer().frame(height: VSpacing.md)

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
            top: VSpacing.md,
            leading: VSpacing.lg,
            bottom: VSpacing.md,
            trailing: VSpacing.md
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
            Circle()
                .fill(VColor.contentTertiary)
                .frame(width: 3, height: 3)
                .padding(.top, 7)
                .accessibilityHidden(true)
            Text(text)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
