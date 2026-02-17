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
            .font(.system(size: 16, design: .monospaced))
            .foregroundColor(VColor.textSecondary)
            .multilineTextAlignment(.center)
            .opacity(showSubtext ? 1 : 0)
            .offset(y: showSubtext ? 0 : 8)

        // Question prompt
        Text("How would you like to start?")
            .font(.system(size: 16, weight: .medium, design: .monospaced))
            .foregroundColor(VColor.textPrimary)
            .opacity(showSubtext ? 1 : 0)
            .offset(y: showSubtext ? 0 : 8)
            .padding(.top, VSpacing.xxl)

        // Option cards
        VStack(spacing: VSpacing.lg) {
            HStack(spacing: VSpacing.md) {
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
            .padding(.top, VSpacing.xl)

            // Progress dots (4 dots)
            HStack(spacing: VSpacing.sm) {
                ForEach(0..<4, id: \.self) { index in
                    Circle()
                        .fill(index == 0 ? VColor.textPrimary : VColor.textMuted.opacity(0.3))
                        .frame(width: index == 0 ? 8 : 6, height: index == 0 ? 8 : 6)
                }
            }
            .padding(.top, VSpacing.lg)

            // Footer
            Text("© 2026 Vellum Inc.")
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(VColor.textMuted.opacity(0.5))
        }
        .padding(.horizontal, VSpacing.xxl)
        .padding(.bottom, VSpacing.xxl)
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
        VStack(spacing: VSpacing.md) {
            Text(title)
                .font(.system(size: 16, weight: .bold, design: .monospaced))
                .foregroundColor(VColor.textPrimary)

            Text(description)
                .font(.system(size: 13, design: .monospaced))
                .foregroundColor(VColor.textMuted)
                .lineSpacing(3)
                .multilineTextAlignment(.center)

            Spacer()

            VButton(label: "Start", action: action)
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .fill(Color.white.opacity(0.02))
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .strokeBorder(Slate._800, lineWidth: 1)
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
