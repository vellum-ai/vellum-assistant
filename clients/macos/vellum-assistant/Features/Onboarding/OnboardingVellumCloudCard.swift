import VellumAssistantShared
import SwiftUI

/// Recommended "Vellum Cloud" card shown in the onboarding first step.
///
/// Self-contained subview: no outside state. Composed into
/// `WakeUpStepView` alongside the sibling "Your Machine" card.
@MainActor
struct OnboardingVellumCloudCard: View {
    // MARK: - Configuration

    let title: String = "Vellum Cloud"
    let benefits: [String] = [
        "No API key or technical setup required",
        "Always on, even when your Mac sleeps",
        "Instant sync across all your devices",
    ]
    let primaryCTA: String = "Continue with Vellum"
    var isLoading: Bool = false
    /// When true, the primary CTA is replaced with a "Logging in…" progress
    /// row. Takes precedence over `isLoading`, which renders "Checking…".
    var isSubmitting: Bool = false
    var isDisabled: Bool = false
    var onContinue: () -> Void

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header: title + RECOMMENDED chip. Uses `titleSmall` so it
            // sits a notch below the page title (`VFont.titleMedium` on
            // `WakeUpStepView`) without clashing with the page's sans
            // family.
            HStack(alignment: .top) {
                Text(title)
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentEmphasized)

                Spacer(minLength: VSpacing.sm)

                VBadge(
                    label: "RECOMMENDED",
                    tone: .positive,
                    emphasis: .subtle,
                    shape: .pill
                )
            }

            Spacer().frame(height: VSpacing.sm)

            // Benefits
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                ForEach(benefits, id: \.self) { benefit in
                    benefitRow(benefit)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Text("Vellum Cloud benefits"))

            Spacer().frame(height: VSpacing.sm)

            // CTA — "Logging in…" wins over "Checking…" when both bits are set,
            // since the user has just submitted credentials and a generic
            // "Checking…" would be misleading during the WorkOS round-trip.
            if isSubmitting {
                loadingRow(label: "Logging in…")
            } else if isLoading {
                loadingRow(label: "Checking…")
            } else {
                VButton(
                    label: primaryCTA,
                    style: .primary,
                    size: .pillRegular,
                    isFullWidth: true,
                    isDisabled: isDisabled
                ) {
                    onContinue()
                }
            }
        }
        .padding(EdgeInsets(
            top: VSpacing.md,
            leading: VSpacing.md,
            bottom: VSpacing.md,
            trailing: VSpacing.md
        ))
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg, style: .continuous)
                .fill(VColor.surfaceLift)
                .shadow(color: VColor.auxBlack.opacity(0.05), radius: 8, x: 0, y: 2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg, style: .continuous)
                .strokeBorder(VColor.borderBase, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
    }

    // MARK: - Subviews

    @ViewBuilder
    private func benefitRow(_ text: String) -> some View {
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

    @ViewBuilder
    private func loadingRow(label: String) -> some View {
        HStack(spacing: VSpacing.sm) {
            ProgressView()
                .controlSize(.small)
                .progressViewStyle(.circular)
            Text(label)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity, minHeight: 32)
    }
}
