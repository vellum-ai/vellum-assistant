import SwiftUI

struct ScreenPermissionStepView: View {
    @Bindable var state: OnboardingState

    @State private var showContent = false
    @State private var permissionGranted = false
    @State private var pollTimer: Timer?

    var body: some View {
        VStack(spacing: VSpacing.xxl) {
            VStack(spacing: VSpacing.md) {
                Text("One more thing \u{2014} let me see.")
                    .font(VFont.onboardingTitle)
                    .foregroundColor(VColor.textPrimary)

                Text("I can hear you and act for you, but I\u{2019}m working blind. Let me see your screen so I know what\u{2019}s happening.")
                    .font(VFont.onboardingSubtitle)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
            }
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 8)

            // Permission card
            VStack(spacing: VSpacing.xl) {
                Text("\u{1F441}")
                    .font(VFont.cardEmoji)

                Text("Help me see")
                    .font(VFont.cardTitle)
                    .foregroundColor(VColor.textPrimary)

                Text("Screen access lets \(state.assistantName) see what you\u{2019}re working on and respond to what\u{2019}s on screen. You can turn this off anytime.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)

                if permissionGranted {
                    HStack(spacing: VSpacing.md) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(VColor.success)
                        Text("I can see your screen now")
                            .foregroundColor(VColor.success)
                            .font(VFont.bodyMedium)
                    }
                    .transition(.scale.combined(with: .opacity))
                } else {
                    OnboardingButton(title: "Let me see", style: .primary) {
                        requestScreenPermission()
                    }
                }
            }
            .padding(VSpacing.xxl)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(VColor.surface.opacity(0.4))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(VColor.onboardingAccent.opacity(0.3), lineWidth: 1)
                    )
            )
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 12)
        }
        .animation(.easeOut(duration: 0.5), value: permissionGranted)
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
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
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
        state.orbMood = .celebrating
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            state.orbMood = .breathing
            state.advance()
        }
    }
}

#Preview {
    ZStack {
        OnboardingBackground()
        VStack {
            SoulOrbView(mood: .breathing)
                .padding(.bottom, 20)
            ScreenPermissionStepView(state: {
                let s = OnboardingState()
                s.currentStep = 4
                return s
            }())
        }
    }
    .frame(width: 1366, height: 849)
}
