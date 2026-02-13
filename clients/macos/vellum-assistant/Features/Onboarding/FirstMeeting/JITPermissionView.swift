import SwiftUI

@MainActor
struct JITPermissionView: View {
    @Bindable var manager: JITPermissionManager

    @State private var showContent = false
    @State private var iconScale: CGFloat = 1.0

    var body: some View {
        ZStack {
            // Dimmed backdrop
            Color.black.opacity(showContent ? 0.5 : 0)
                .ignoresSafeArea()
                .onTapGesture {
                    dismiss()
                }

            if let request = manager.activePermissionRequest {
                permissionCard(for: request)
                    .transition(
                        .asymmetric(
                            insertion: .opacity.combined(with: .scale(scale: 0.92)),
                            removal: .opacity.combined(with: .scale(scale: 0.95))
                        )
                    )
            }
        }
        .animation(VAnimation.panel, value: manager.activePermissionRequest != nil)
        .onChange(of: manager.activePermissionRequest) { _, newValue in
            if newValue != nil {
                showContent = false
                iconScale = 1.0
                withAnimation(.easeOut(duration: 0.4).delay(0.1)) {
                    showContent = true
                }
                startIconBreathing()
            } else {
                withAnimation(VAnimation.fast) {
                    showContent = false
                }
            }
        }
    }

    // MARK: - Permission Card

    private func permissionCard(for request: JITPermissionManager.JITPermissionType) -> some View {
        VStack(spacing: VSpacing.xl) {
            // Body part icon with breathing animation
            ZStack {
                // Glow behind icon
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [
                                VColor.accent.opacity(0.3),
                                VColor.accent.opacity(0.0)
                            ],
                            center: .center,
                            startRadius: 0,
                            endRadius: 40
                        )
                    )
                    .frame(width: 80, height: 80)
                    .scaleEffect(iconScale)

                Image(systemName: request.icon)
                    .font(.system(size: 32, weight: .light))
                    .foregroundColor(VColor.accent)
                    .scaleEffect(iconScale)
            }
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 8)

            // Title
            VStack(spacing: VSpacing.sm) {
                Text(request.title)
                    .font(VFont.onboardingTitle)
                    .foregroundColor(VColor.textPrimary)

                Text(request.message)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 320)
            }
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 6)

            // Explanation card
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "lock.shield")
                        .font(.system(size: 11))
                        .foregroundColor(VColor.textMuted)
                    Text("Privacy")
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.textMuted)
                }

                Text(request.explanation)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(VSpacing.lg)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(VColor.surface.opacity(0.3))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.surfaceBorder.opacity(0.4), lineWidth: 1)
                    )
            )
            .opacity(showContent ? 1 : 0)

            // Buttons
            VStack(spacing: VSpacing.md) {
                OnboardingButton(title: "Allow", style: .primary) {
                    manager.grantActivePermission()
                }

                Button("Not now") {
                    dismiss()
                }
                .buttonStyle(.plain)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
            }
            .opacity(showContent ? 1 : 0)
        }
        .padding(.horizontal, VSpacing.xxl)
        .padding(.vertical, VSpacing.xxxl)
        .frame(maxWidth: 420)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(.ultraThinMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .fill(Meadow.panelBackground)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(Meadow.panelBorder, lineWidth: 1)
                )
        )
        .shadow(color: .black.opacity(0.5), radius: 32, y: 16)
    }

    // MARK: - Helpers

    private func dismiss() {
        manager.dismissActivePermission()
    }

    private func startIconBreathing() {
        withAnimation(
            .easeInOut(duration: 2.0)
            .repeatForever(autoreverses: true)
        ) {
            iconScale = 1.08
        }
    }
}

// MARK: - Preview

#Preview("Microphone") {
    @Previewable @State var manager: JITPermissionManager = {
        let m = JITPermissionManager()
        m.isActive = true
        m.activePermissionRequest = .microphone
        return m
    }()

    ZStack {
        VColor.background.ignoresSafeArea()
        JITPermissionView(manager: manager)
    }
    .frame(width: 640, height: 560)
}

#Preview("Accessibility") {
    @Previewable @State var manager: JITPermissionManager = {
        let m = JITPermissionManager()
        m.isActive = true
        m.activePermissionRequest = .accessibility
        return m
    }()

    ZStack {
        VColor.background.ignoresSafeArea()
        JITPermissionView(manager: manager)
    }
    .frame(width: 640, height: 560)
}

#Preview("Screen Capture") {
    @Previewable @State var manager: JITPermissionManager = {
        let m = JITPermissionManager()
        m.isActive = true
        m.activePermissionRequest = .screenCapture
        return m
    }()

    ZStack {
        VColor.background.ignoresSafeArea()
        JITPermissionView(manager: manager)
    }
    .frame(width: 640, height: 560)
}
