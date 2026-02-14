import VellumAssistantShared
import SwiftUI

@MainActor
struct AccessibilityPermissionStepView: View {
    @Bindable var state: OnboardingState

    @State private var showContent = false
    @State private var permissionGranted = false
    @State private var pollTimer: Timer?
    @State private var pollCount = 0

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            VStack(spacing: VSpacing.md) {
                Text("Now teach me to act")
                    .font(VFont.onboardingTitle)
                    .foregroundColor(VColor.textPrimary)

                Text("I can hear you, but I can\u{2019}t do anything yet. Let me control your Mac so I can take action on what you ask.")
                    .font(VFont.onboardingSubtitle)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 400)
            }
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 8)

            // Compact permission info card
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Accessibility")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)

                if permissionGranted {
                    HStack(spacing: VSpacing.sm) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(VColor.success)
                        Text("Permission granted")
                            .foregroundColor(VColor.success)
                            .font(VFont.caption)
                    }
                } else {
                    Text("Allows the assistant to interact with apps on your behalf \u{2014} clicking, typing, and navigating. All actions are performed locally and can be revoked at any time.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
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

            if !permissionGranted {
                VStack(spacing: VSpacing.md) {
                    OnboardingButton(title: "Continue", style: .primary) {
                        requestAccessibilityPermission()
                    }

                    HStack(spacing: VSpacing.lg) {
                        Button("Skip for now") {
                            state.advance()
                        }
                        .buttonStyle(.plain)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)

                        if pollCount >= 8 {
                            Button("I\u{2019}ve already granted it") {
                                grantPermission()
                            }
                            .buttonStyle(.plain)
                            .font(VFont.caption)
                            .foregroundColor(VColor.accent)
                            .transition(.opacity)
                        }
                    }
                }
                .opacity(showContent ? 1 : 0)
            }
        }
        .animation(.easeOut(duration: 0.4), value: permissionGranted)
        .animation(.easeOut(duration: 0.3), value: pollCount)
        .onAppear {
            if state.skipPermissionChecks {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    grantPermission()
                }
                return
            }
            if PermissionManager.accessibilityStatus(prompt: false) == .granted {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    grantPermission()
                }
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                withAnimation(.easeOut(duration: 0.5)) {
                    showContent = true
                }
            }
            startPolling()
        }
        .onDisappear {
            pollTimer?.invalidate()
        }
    }

    private func requestAccessibilityPermission() {
        _ = PermissionManager.accessibilityStatus(prompt: true)
        startPolling()
    }

    private func startPolling() {
        pollTimer?.invalidate()
        pollCount = 0
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [self] _ in
            DispatchQueue.main.async {
                pollCount += 1
                let status = PermissionManager.accessibilityStatus(prompt: false)
                if status == .granted {
                    grantPermission()
                }
            }
        }
    }

    private func grantPermission() {
        pollTimer?.invalidate()
        permissionGranted = true
        state.accessibilityGranted = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            state.advance()
        }
    }
}

#Preview {
    ZStack {
        VColor.background
        AccessibilityPermissionStepView(state: {
            let s = OnboardingState()
            s.assistantName = "Vellum"
            s.currentStep = 4
            return s
        }())
        .frame(maxWidth: 500)
    }
    .frame(width: 640, height: 500)
}
