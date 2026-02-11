import SwiftUI

struct AccessibilityPermissionStepView: View {
    @Bindable var state: OnboardingState

    @State private var showContent = false
    @State private var permissionGranted = false
    @State private var pollTimer: Timer?

    private static let reactions = [
        "Sound! I can hear everything \u{2014} this is wild.",
        "Wait\u{2026} is that your voice? I can hear you!",
        "Oh \u{2014} so *that\u{2019}s* what the world sounds like.",
    ]

    var body: some View {
        VStack(spacing: 24) {
            if permissionGranted {
                ReactionBubble(text: "I can take action now.", delay: 0)
            } else {
                ReactionBubble(text: Self.reactions.randomElement()!)
            }

            VStack(spacing: 8) {
                Text("Now teach me to act.")
                    .font(.system(.title2, design: .serif))
                    .foregroundColor(.white)

                Text("I can hear you, but I can\u{2019}t do anything yet. Let me control your Mac so I can take action on what you ask.")
                    .font(.system(size: 15))
                    .foregroundColor(.white.opacity(0.5))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
            }
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 8)

            // Permission card
            VStack(spacing: 16) {
                Text("\u{1F932}")
                    .font(.system(size: 32))

                Text("Give me hands")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(.white)

                Text("Accessibility access lets \(state.assistantName) click, type, and navigate your Mac for you. macOS will ask you to flip a switch in System Settings.")
                    .font(.system(size: 13))
                    .foregroundColor(.white.opacity(0.5))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)

                if permissionGranted {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                        Text("I can take action now")
                            .foregroundColor(.green)
                            .font(.system(size: 15, weight: .medium))
                    }
                    .transition(.scale.combined(with: .opacity))
                } else {
                    VStack(spacing: 8) {
                        OnboardingButton(title: "Let me help", style: .primary) {
                            requestAccessibilityPermission()
                        }

                        Text("You\u{2019}ll be sent to System Settings \u{2014} come back here after.")
                            .font(.system(size: 12))
                            .foregroundColor(.white.opacity(0.35))
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
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 12)
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
            // Auto-advance if permission was already granted (e.g. after restart)
            if PermissionManager.accessibilityStatus(prompt: false) == .granted {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    grantPermission()
                }
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
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
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            let status = PermissionManager.accessibilityStatus(prompt: false)
            if status == .granted {
                DispatchQueue.main.async {
                    grantPermission()
                }
            }
        }
    }

    private func grantPermission() {
        pollTimer?.invalidate()
        permissionGranted = true
        state.accessibilityGranted = true
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
            AccessibilityPermissionStepView(state: {
                let s = OnboardingState()
                s.assistantName = "Vellum"
                s.currentStep = 4
                return s
            }())
        }
    }
    .frame(width: 600, height: 500)
}
