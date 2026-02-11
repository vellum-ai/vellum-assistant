import ScreenCaptureKit
import SwiftUI

struct ScreenPermissionStepView: View {
    @Bindable var state: OnboardingState

    @State private var showContent = false
    @State private var permissionGranted = false
    @State private var pollTimer: Timer?

    var body: some View {
        VStack(spacing: VellumSpacing.xxl) {
            VStack(spacing: VellumSpacing.md) {
                Text("One more thing \u{2014} let me see.")
                    .font(VellumFont.onboardingTitle)
                    .foregroundColor(VellumTheme.textPrimary)

                Text("I can hear you and act for you, but I\u{2019}m working blind. Let me see your screen so I know what\u{2019}s happening.")
                    .font(VellumFont.onboardingSubtitle)
                    .foregroundColor(VellumTheme.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
            }
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 8)

            // Permission card
            VStack(spacing: VellumSpacing.xl) {
                Text("\u{1F441}")
                    .font(VellumFont.cardEmoji)

                Text("Help me see")
                    .font(VellumFont.cardTitle)
                    .foregroundColor(VellumTheme.textPrimary)

                Text("Screen access lets \(state.assistantName) see what you\u{2019}re working on and respond to what\u{2019}s on screen. You can turn this off anytime.")
                    .font(VellumFont.caption)
                    .foregroundColor(VellumTheme.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)

                if permissionGranted {
                    HStack(spacing: VellumSpacing.md) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(VellumTheme.success)
                        Text("I can see your screen now")
                            .foregroundColor(VellumTheme.success)
                            .font(VellumFont.bodyMedium)
                    }
                    .transition(.scale.combined(with: .opacity))
                } else {
                    OnboardingButton(title: "Let me see", style: .primary) {
                        requestScreenPermission()
                    }
                }
            }
            .padding(VellumSpacing.xxl)
            .background(
                RoundedRectangle(cornerRadius: VellumRadius.lg)
                    .fill(VellumTheme.surface.opacity(0.4))
                    .overlay(
                        RoundedRectangle(cornerRadius: VellumRadius.lg)
                            .stroke(VellumTheme.onboardingAccent.opacity(0.3), lineWidth: 1)
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
            Task {
                let status = await PermissionManager.screenRecordingStatus()
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
        }
        .onDisappear {
            pollTimer?.invalidate()
        }
    }

    private func requestScreenPermission() {
        Task {
            do {
                _ = try await SCShareableContent.current
                grantPermission()
            } catch {
                startPolling()
            }
        }
    }

    private func startPolling() {
        pollTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { _ in
            Task { @MainActor in
                let status = await PermissionManager.screenRecordingStatus()
                if status == .granted {
                    grantPermission()
                }
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
    .frame(width: 600, height: 500)
}
