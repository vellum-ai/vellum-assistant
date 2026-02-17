import VellumAssistantShared
import SwiftUI

@MainActor
struct WakeUpStepView: View {
    @Bindable var state: OnboardingState
    var onContinueWithVellum: () -> Void = {}

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

        Spacer()

        // Buttons
        VStack(spacing: VSpacing.md) {
            Button(action: { advanceStep() }) {
                Text("Start with an API key")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, VSpacing.lg)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .fill(adaptiveColor(
                                light: Color(nsColor: NSColor(red: 0.12, green: 0.12, blue: 0.12, alpha: 1)),
                                dark: Violet._600
                            ))
                    )
            }
            .buttonStyle(.plain)
            .onHover { hovering in
                if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }

            Button(action: { onContinueWithVellum() }) {
                Text("Continue with Vellum")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundColor(VColor.textPrimary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, VSpacing.lg)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .fill(adaptiveColor(light: .white, dark: VColor.surface))
                    )
            }
            .buttonStyle(.plain)
            .onHover { hovering in
                if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }
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
    .frame(width: 460, height: 520)
}
