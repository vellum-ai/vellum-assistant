import AVFoundation
import SwiftUI

struct MicPermissionStepView: View {
    @Bindable var state: OnboardingState

    @State private var showCard = false
    @State private var permissionGranted = false
    @State private var pollTimer: Timer?

    var body: some View {
        VStack(spacing: 24) {
            ReactionBubble(
                text: "Now let's give me ears so I can hear you."
            )

            // Permission card
            VStack(spacing: 16) {
                Text("\u{1F399}")
                    .font(.system(size: 32))

                Text("Microphone Access")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(.white)

                Text("I need mic access so you can talk to me with your voice.")
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
                    OnboardingButton(title: "Enable Microphone", style: .primary) {
                        requestMicPermission()
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
            state.orbMood = .listening
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

    private func requestMicPermission() {
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            DispatchQueue.main.async {
                if granted {
                    grantPermission()
                }
            }
        }
        startPolling()
    }

    private func startPolling() {
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            let status = AVCaptureDevice.authorizationStatus(for: .audio)
            if status == .authorized {
                DispatchQueue.main.async {
                    grantPermission()
                }
            }
        }
    }

    private func grantPermission() {
        pollTimer?.invalidate()
        permissionGranted = true
        state.micGranted = true
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
            SoulOrbView(mood: .listening)
                .padding(.bottom, 20)
            MicPermissionStepView(state: {
                let s = OnboardingState()
                s.currentStep = 3
                return s
            }())
        }
    }
    .frame(width: 600, height: 500)
}
