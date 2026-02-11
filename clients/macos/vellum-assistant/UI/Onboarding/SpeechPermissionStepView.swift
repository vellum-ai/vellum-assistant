import Speech
import SwiftUI

struct SpeechPermissionStepView: View {
    @Bindable var state: OnboardingState

    @State private var showCard = false
    @State private var permissionGranted = false
    @State private var permissionDenied = false
    @State private var pollTimer: Timer?

    var body: some View {
        VStack(spacing: 16) {
            if permissionGranted {
                ReactionBubble(text: "I can understand you now.", delay: 0)
            } else if permissionDenied {
                ReactionBubble(
                    text: "Still can\u{2019}t hear. That\u{2019}s okay \u{2014} we\u{2019}ll try again when you\u{2019}re ready.",
                    delay: 0
                )
            } else {
                ReactionBubble(
                    text: "I\u{2019}m trying to hear you but\u{2026} everything is muffled."
                )
            }

            // Permission card
            VStack(spacing: 12) {
                Text("\u{1F399}")
                    .font(.system(size: 28))

                Text("Help me hear")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(.white)

                Text("To understand you when you hold \(state.chosenKey.displayName), \(state.assistantName) needs speech recognition access. Your Mac will ask \u{2014} just tap Allow.")
                    .font(.system(size: 13))
                    .foregroundColor(.white.opacity(0.5))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)

                if permissionGranted {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                        Text("I can understand you now")
                            .foregroundColor(.green)
                            .font(.system(size: 15, weight: .medium))
                    }
                    .transition(.scale.combined(with: .opacity))
                } else {
                    OnboardingButton(title: "Let me listen", style: .primary) {
                        requestSpeechPermission()
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
            .opacity(showCard ? 1 : 0)
            .offset(y: showCard ? 0 : 12)

            if permissionDenied {
                OnboardingButton(title: "Continue anyway", style: .ghost) {
                    state.advance()
                }
            }
        }
        .animation(.easeOut(duration: 0.5), value: permissionGranted)
        .animation(.easeOut(duration: 0.3), value: permissionDenied)
        .onAppear {
            state.orbMood = .listening
            if state.skipPermissionChecks {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    grantPermission()
                }
                return
            }
            // Auto-advance if permission was already granted (e.g. after restart)
            if SFSpeechRecognizer.authorizationStatus() == .authorized {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
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

    private func requestSpeechPermission() {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                switch status {
                case .authorized:
                    grantPermission()
                case .denied, .restricted:
                    permissionDenied = true
                default:
                    break
                }
            }
        }
        startPolling()
    }

    private func startPolling() {
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            let status = SFSpeechRecognizer.authorizationStatus()
            DispatchQueue.main.async {
                if status == .authorized {
                    grantPermission()
                }
            }
        }
    }

    private func grantPermission() {
        pollTimer?.invalidate()
        permissionGranted = true
        permissionDenied = false
        state.speechGranted = true
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
            SpeechPermissionStepView(state: {
                let s = OnboardingState()
                s.assistantName = "Vellum"
                s.currentStep = 3
                return s
            }())
        }
    }
    .frame(width: 600, height: 500)
}
