import AppKit
import VellumAssistantShared
import SwiftUI

@MainActor
struct WelcomeStepView: View {
    var onGetStarted: () -> Void

    @State private var showLogo = false
    @State private var showTitle = false
    @State private var showButton = false

    private var vellumIcon: NSImage? {
        ResourceBundle.bundle.image(forResource: "VellumIcon")
    }

    var body: some View {
        // Icon
        Group {
            if let icon = vellumIcon {
                Image(nsImage: icon)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
            }
        }
        .frame(width: 64, height: 64)
        .opacity(showLogo ? 1 : 0)
        .offset(y: showLogo ? 0 : 8)
        .padding(.bottom, VSpacing.lg)

        // Title
        Text("Create your vellum")
            .font(.system(size: 32, weight: .regular, design: .serif))
            .foregroundColor(VColor.textPrimary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.xxl)

        // Get Started button
        Button(action: { onGetStarted() }) {
            Text("Get started")
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(.white)
                .frame(maxWidth: 240)
                .padding(.vertical, VSpacing.lg)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .fill(adaptiveColor(
                            light: Stone._900,
                            dark: Forest._600
                        ))
                )
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .opacity(showButton ? 1 : 0)
        .offset(y: showButton ? 0 : 12)

        Spacer()

        OnboardingFooter(currentStep: 0)
            .padding(.bottom, VSpacing.lg)
            .opacity(showButton ? 1 : 0)

        // Staggered entrance animations
        Color.clear.frame(height: 0)
            .onAppear {
                withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                    showLogo = true
                }
                withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                    showTitle = true
                }
                withAnimation(.easeOut(duration: 0.5).delay(0.5)) {
                    showButton = true
                }
            }
    }
}

#Preview {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: 0) {
            Spacer()
            WelcomeStepView(onGetStarted: {})
        }
    }
    .frame(width: 460, height: 620)
}
