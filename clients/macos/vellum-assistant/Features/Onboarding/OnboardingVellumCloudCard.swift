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
    let subtitle: String = "The frictionless experience for serious creators."
    let benefits: [String] = [
        "Always on, even when your Mac sleeps",
        "Instant sync across all your devices",
        "No API key or technical setup required",
        "Automatic two-way transfer & backup",
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
            // Header: title + RECOMMENDED chip. Uses `titleMedium` so it
            // sits a notch below the page title (`VFont.titleLarge` on
            // `WakeUpStepView`) without clashing with the page's sans
            // family.
            HStack(alignment: .top) {
                Text(title)
                    .font(VFont.titleMedium)
                    .foregroundStyle(VColor.contentEmphasized)

                Spacer(minLength: VSpacing.sm)

                VBadge(
                    label: "RECOMMENDED",
                    tone: .neutral,
                    emphasis: .subtle,
                    shape: .pill
                )
            }

            Spacer().frame(height: VSpacing.xs)

            Text(subtitle)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
                .fixedSize(horizontal: false, vertical: true)

            Spacer().frame(height: VSpacing.lg)

            // Benefits
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                ForEach(benefits, id: \.self) { benefit in
                    benefitRow(benefit)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Text("Vellum Cloud benefits"))

            Spacer().frame(height: VSpacing.lg)

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
            top: VSpacing.lg,
            leading: VSpacing.lg,
            bottom: VSpacing.lg,
            trailing: VSpacing.lg
        ))
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg, style: .continuous)
                .fill(VColor.surfaceLift)
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
            VIconView(.circleCheck, size: 16)
                .foregroundStyle(VColor.contentSecondary)
                .accessibilityHidden(true)
            Text(text)
                .font(VFont.bodyMediumDefault)
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
