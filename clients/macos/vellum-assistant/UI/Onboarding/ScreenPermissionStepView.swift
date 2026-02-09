import ScreenCaptureKit
import SwiftUI

struct ScreenPermissionStepView: View {
    @Bindable var state: OnboardingState

    @State private var showCard = false
    @State private var permissionGranted = false
    @State private var pollTimer: Timer?

    var body: some View {
        VStack(spacing: 24) {
            ReactionBubble(
                text: "Almost there! Now let's give me eyes."
            )

            // Permission card
            VStack(spacing: 16) {
                Text("\u{1F441}")
                    .font(.system(size: 32))

                Text("Screen Recording")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(.white)

                Text("I need to see your screen so I can help you navigate and complete tasks.")
                    .font(.system(size: 13))
                    .foregroundColor(.white.opacity(0.5))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)

                if permissionGranted {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                        Text("Granted!")
                            .foregroundColor(.green)
                            .font(.system(size: 15, weight: .medium))
                    }
                    .transition(.scale.combined(with: .opacity))
                } else {
                    OnboardingButton(title: "Enable Screen Recording", style: .primary) {
                        requestScreenPermission()
                    }
                }
            }
            .padding(24)
            .background(
                RoundedRectangle(cornerRadius: 16)
                    .fill(Color.white.opacity(0.05))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16)
                            .stroke(Color(hex: 0xD4A843).opacity(0.3), lineWidth: 1)
                    )
            )
            .opacity(showCard ? 1 : 0)
            .offset(y: showCard ? 0 : 12)
        }
        .animation(.easeOut(duration: 0.5), value: permissionGranted)
        .onAppear {
            if state.skipPermissionChecks {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    grantPermission()
                }
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                withAnimation(.easeOut(duration: 0.5)) {
                    showCard = true
                }
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
