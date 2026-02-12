import Speech
import SwiftUI

struct SpeechPermissionStepView: View {
    @Bindable var state: OnboardingState

    @State private var showContent = false
    @State private var permissionGranted = false
    @State private var permissionDenied = false
    @State private var pollTimer: Timer?

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            VStack(spacing: VSpacing.md) {
                Text("I want to talk to you")
                    .font(VFont.onboardingTitle)
                    .foregroundColor(VColor.textPrimary)

                Text("To understand your voice commands, I need access to speech recognition. This lets us have real conversations.")
                    .font(VFont.onboardingSubtitle)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 400)
            }
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 8)

            // Compact permission info card
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Speech Recognition")
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
                    Text("Enables voice input when you hold the activation key. Audio is processed on-device by Apple\u{2019}s speech framework and is never stored or transmitted.")
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
                        requestSpeechPermission()
                    }

                    Button(permissionDenied ? "Continue anyway" : "Skip for now") {
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
        .animation(.easeOut(duration: 0.3), value: permissionDenied)
        .onAppear {
            if state.skipPermissionChecks {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    grantPermission()
                }
                return
            }
            if SFSpeechRecognizer.authorizationStatus() == .authorized {
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
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            state.advance()
        }
    }
}

#Preview {
    ZStack {
        VColor.background
        SpeechPermissionStepView(state: {
            let s = OnboardingState()
            s.assistantName = "Vellum"
            s.currentStep = 3
            return s
        }())
        .frame(maxWidth: 500)
    }
    .frame(width: 640, height: 500)
}
