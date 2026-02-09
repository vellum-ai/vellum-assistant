import AVFoundation
import SwiftUI

struct MicPermissionStepView: View {
    @Bindable var state: OnboardingState

    @State private var showCard = false
    @State private var permissionGranted = false
    @State private var grantReaction: String?
    @State private var pollTimer: Timer?

    private static let grantReactions = [
        "Sound! I can hear everything \u{2014} this is wild.",
        "Wait\u{2026} is that your voice? I can hear you!",
        "Oh \u{2014} so *that\u{2019}s* what the world sounds like.",
    ]

    var body: some View {
        VStack(spacing: 24) {
            if let reaction = grantReaction {
                ReactionBubble(text: reaction, delay: 0)
            } else {
                ReactionBubble(
                    text: "I\u{2019}m trying to hear you but\u{2026} everything is muffled."
                )
            }

            // Permission card
            VStack(spacing: 16) {
                Text("\u{1F399}")
                    .font(.system(size: 32))

                Text("Help me hear")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(.white)

                Text("To hear you when you hold \(state.chosenKey.displayName), \(state.assistantName) needs microphone access. Your system will ask \u{2014} just say yes.")
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
        grantReaction = Self.grantReactions.randomElement()
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
