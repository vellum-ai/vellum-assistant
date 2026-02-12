import SwiftUI

struct ScreenPermissionStepView: View {
    @Bindable var state: OnboardingState

    @State private var showContent = false
    @State private var permissionGranted = false
    @State private var pollTimer: Timer?

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            VStack(spacing: VSpacing.md) {
                Text("Last thing, give me eyes")
                    .font(VFont.onboardingTitle)
                    .foregroundColor(VColor.textPrimary)

                Text("Without this, I\u{2019}m navigating in the dark. Let me see your screen so I can help with what\u{2019}s in front of you.")
                    .font(VFont.onboardingSubtitle)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 400)
            }
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 8)

            // Compact permission info card
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Screen Recording")
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
                    Text("Lets the assistant see your screen to understand context and provide relevant help. Screenshots are processed locally and never uploaded.")
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
                        requestScreenPermission()
                    }

                    Button("Skip for now") {
                        state.advance()
                    }
                    .buttonStyle(.plain)
                    .font(VFont.small)
                    .foregroundColor(VColor.textMuted)
                }
                .opacity(showContent ? 1 : 0)
            }
        }
        .animation(.easeOut(duration: 0.4), value: permissionGranted)
        .onAppear {
            if state.skipPermissionChecks {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    grantPermission()
                }
                return
            }
            let status = PermissionManager.screenRecordingStatus()
            if status == .granted {
                grantPermission()
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                withAnimation(.easeOut(duration: 0.5)) {
                    showContent = true
                }
            }
        }
        .onDisappear {
            pollTimer?.invalidate()
        }
    }

    private func requestScreenPermission() {
        PermissionManager.requestScreenRecordingAccess()
        startPolling()
    }

    private func startPolling() {
        pollTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { _ in
            let status = PermissionManager.screenRecordingStatus()
            if status == .granted {
                grantPermission()
            }
        }
    }

    private func grantPermission() {
        pollTimer?.invalidate()
        permissionGranted = true
        state.screenGranted = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            state.advance()
        }
    }
}

#Preview {
    ZStack {
        VColor.background
        ScreenPermissionStepView(state: {
            let s = OnboardingState()
            s.currentStep = 5
            return s
        }())
        .frame(maxWidth: 500)
    }
    .frame(width: 640, height: 500)
}
