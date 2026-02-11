import ScreenCaptureKit
import SwiftUI

struct ScreenPermissionStepView: View {
    @Bindable var state: OnboardingState

    @State private var showContent = false
    @State private var permissionGranted = false
    @State private var pollTimer: Timer?
    @State private var showSkip = false

    var body: some View {
        VStack(spacing: 16) {
            VStack(spacing: 8) {
                Text("One more thing \u{2014} let me see.")
                    .font(.system(.title2, design: .serif))
                    .foregroundColor(.white)

                Text("I can hear you and act for you, but I\u{2019}m working blind. Let me see your screen so I know what\u{2019}s happening.")
                    .font(.system(size: 15))
                    .foregroundColor(.white.opacity(0.5))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
            }
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 8)

            // Permission card
            VStack(spacing: 12) {
                Text("\u{1F441}")
                    .font(.system(size: 28))

                Text("Help me see")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(.white)

                Text("Screen access lets \(state.assistantName) see what you\u{2019}re working on and respond to what\u{2019}s on screen. You can turn this off anytime.")
                    .font(.system(size: 13))
                    .foregroundColor(.white.opacity(0.5))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)

                if permissionGranted {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                        Text("I can see your screen now")
                            .foregroundColor(.green)
                            .font(.system(size: 15, weight: .medium))
                    }
                    .transition(.scale.combined(with: .opacity))
                } else {
                    OnboardingButton(title: "Let me see", style: .primary) {
                        requestScreenPermission()
                    }
                }
            }
            .padding(16)
            .background(
                RoundedRectangle(cornerRadius: 16)
                    .fill(Color.white.opacity(0.05))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16)
                            .stroke(Color(hex: 0xD4A843).opacity(0.3), lineWidth: 1)
                    )
            )
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 12)

            if showSkip && !permissionGranted {
                OnboardingButton(title: "Continue anyway", style: .ghost) {
                    grantPermission()
                }
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.5), value: permissionGranted)
        .animation(.easeOut(duration: 0.3), value: showSkip)
        .onAppear {
            if state.skipPermissionChecks {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    grantPermission()
                }
                return
            }
            // Auto-advance if permission was already granted (e.g. after restart)
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
            DispatchQueue.main.asyncAfter(deadline: .now() + 6.0) {
                withAnimation { showSkip = true }
            }
        }
        .onDisappear {
            pollTimer?.invalidate()
        }
    }

    private func requestScreenPermission() {
        // Calling SCShareableContent.current triggers the system permission dialog
        Task {
            do {
                _ = try await SCShareableContent.current
                grantPermission()
            } catch {
                // Permission denied or dialog shown — start polling
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
