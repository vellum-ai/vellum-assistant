import VellumAssistantShared
import SwiftUI

@MainActor
struct WakeUpStepView: View {
    @Bindable var state: OnboardingState

    @State private var showTitle = false
    @State private var showSubtext = false
    @State private var showButtons = false
    @State private var isAdvancing = false

    var body: some View {
        // Title
        Text("Create your Velly")
            .font(.system(size: 32, weight: .regular, design: .serif))
            .foregroundColor(VColor.textPrimary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        // Subtitle
        Text("The safest way to create your personal assistant.")
            .font(.system(size: 16))
            .foregroundColor(VColor.textSecondary)
            .opacity(showSubtext ? 1 : 0)
            .offset(y: showSubtext ? 0 : 8)

        // Question prompt
        Text("How would you like to start?")
            .font(.system(size: 16, weight: .medium))
            .foregroundColor(VColor.textPrimary)
            .opacity(showSubtext ? 1 : 0)
            .offset(y: showSubtext ? 0 : 8)
            .padding(.top, VSpacing.xl)

        Spacer()

        // Option cards
        VStack(spacing: VSpacing.lg) {
            HStack(spacing: VSpacing.lg) {
                // Card 1: Own API Key
                optionCard(
                    title: "Own API Key",
                    description: "When you already have a subscription to a model.",
                    action: { advanceStep() }
                )

                // Card 2: Vellum Account
                optionCard(
                    title: "Vellum Account",
                    description: "Get 30 free credits starting with your Vellum Account without the need for your own model subscription.",
                    action: {}
                )
            }

            // Progress dots
            OnboardingProgressDots(currentStep: 0, totalSteps: 4)
                .padding(.top, VSpacing.sm)

            // Footer
            Text("2026 Vellum Inc.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .padding(.bottom, VSpacing.sm)
        }
        .padding(.horizontal, VSpacing.xxl)
        .padding(.bottom, VSpacing.lg)
        .opacity(showButtons ? 1 : 0)
        .offset(y: showButtons ? 0 : 12)
        .disabled(isAdvancing)
        .onAppear {
            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                showSubtext = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.5)) {
                showButtons = true
            }
        }
    }

    // MARK: - Option Card

    @ViewBuilder
    private func optionCard(
        title: String,
        description: String,
        action: @escaping () -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text(title)
                .font(.system(size: 15, weight: .bold))
                .foregroundColor(VColor.textPrimary)

            Text(description)
                .font(.system(size: 13))
                .foregroundColor(VColor.textSecondary)
                .lineSpacing(3)

            Spacer()

            Button(action: action) {
                Text("Start")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, VSpacing.sm)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .fill(Violet._600)
                    )
            }
            .buttonStyle(.plain)
            .onHover { hovering in
                if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }
        }
        .padding(VSpacing.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .fill(VColor.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
    }

    // MARK: - Advance

    private func advanceStep() {
        guard !isAdvancing else { return }
        isAdvancing = true
        state.hasHatched = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            state.advance()
        }
    }
}

#Preview {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: 0) {
            Spacer()
            Image("VellyLogo")
                .resizable()
                .interpolation(.none)
                .aspectRatio(contentMode: .fit)
                .frame(width: 128, height: 128)
                .padding(.bottom, VSpacing.xxl)
            WakeUpStepView(state: OnboardingState())
        }
    }
    .frame(width: 520, height: 580)
}
