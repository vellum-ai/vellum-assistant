import VellumAssistantShared
import SwiftUI
import AVFoundation
import Speech

@MainActor
struct FnKeyStepView: View {
    @Bindable var state: OnboardingState

    @State private var showTitle = false
    @State private var showContent = false
    @State private var pulseScale: CGFloat = 1.0
    @State private var micGranted = false
    @State private var speechGranted = false
    @State private var permissionsRequested = false
    @State private var permissionPollTimer: Timer?

    private var allPermissionsGranted: Bool {
        micGranted && speechGranted
    }

    var body: some View {
        // Title
        Text("Need voice mode?")
            .font(.system(size: 32, weight: .regular, design: .serif))
            .foregroundColor(VColor.textPrimary)
            .textSelection(.enabled)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        // Subtitle
        Text(permissionsRequested
             ? "Grant the permissions to continue."
             : "Hold fn + shift anywhere to talk to \(state.assistantName).")
            .font(.system(size: 16))
            .foregroundColor(VColor.textSecondary)
            .textSelection(.enabled)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .animation(.easeInOut(duration: 0.3), value: permissionsRequested)

        Spacer()

        // Content area
        VStack(spacing: VSpacing.md) {
            if permissionsRequested {
                // Permission status rows
                VStack(spacing: 0) {
                    permissionRow(
                        icon: VIcon.mic.rawValue,
                        label: "Microphone",
                        granted: micGranted
                    )
                    Divider()
                        .background(VColor.surfaceBorder)
                    permissionRow(
                        icon: "waveform",
                        label: "Speech Recognition",
                        granted: speechGranted
                    )
                }
                .background(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.surfaceBorder, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                .transition(.opacity.combined(with: .move(edge: .trailing)))
            } else {
                // Key badge row
                HStack(spacing: VSpacing.sm) {
                    keyBadge("fn")
                    Text("+")
                        .font(.system(size: 18, weight: .medium, design: .monospaced))
                        .foregroundColor(VColor.textMuted)
                    keyBadge("shift")
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, VSpacing.lg)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.surfaceBorder, lineWidth: 1)
                )
                .scaleEffect(pulseScale)
                .transition(.opacity.combined(with: .move(edge: .leading)))
            }

            // Primary button
            if allPermissionsGranted {
                Button(action: {
                    state.chosenKey = .fnShift
                    state.advance()
                }) {
                    Text("Continue")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, VSpacing.lg)
                        .background(
                            RoundedRectangle(cornerRadius: VRadius.lg)
                                .fill(adaptiveColor(
                                    light: Stone._900,
                                    dark: Forest._600
                                ))
                        )
                }
                .buttonStyle(.plain)
                .pointerCursor()
                .transition(.opacity)
            } else {
                Button(action: { requestPermissions() }) {
                    Text(permissionsRequested ? "Open System Settings" : "Enable Voice Mode")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, VSpacing.lg)
                        .background(
                            RoundedRectangle(cornerRadius: VRadius.lg)
                                .fill(adaptiveColor(
                                    light: Stone._900,
                                    dark: Forest._600
                                ))
                        )
                }
                .buttonStyle(.plain)
                .pointerCursor()
            }

            // Skip + Back
            HStack(spacing: VSpacing.lg) {
                Button(action: {
                    stopPolling()
                    state.chosenKey = .none
                    state.advance()
                }) {
                    Text("Skip")
                        .font(.system(size: 13))
                        .foregroundColor(VColor.textMuted)
                }
                .buttonStyle(.plain)
                .pointerCursor()

                Button(action: {
                    stopPolling()
                    withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
                        state.currentStep = 3
                    }
                }) {
                    Text("Back")
                        .font(.system(size: 13))
                        .foregroundColor(VColor.textMuted)
                }
                .buttonStyle(.plain)
                .pointerCursor()
            }
            .padding(.top, VSpacing.xs)
        }
        .padding(.horizontal, VSpacing.xxl)
        .padding(.bottom, VSpacing.lg)
        .opacity(showContent ? 1 : 0)
        .offset(y: showContent ? 0 : 12)
        .animation(.spring(duration: 0.4, bounce: 0.1), value: permissionsRequested)
        .animation(.spring(duration: 0.4, bounce: 0.1), value: allPermissionsGranted)
        .onAppear {
            checkCurrentPermissions()
            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                showContent = true
            }
            withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true).delay(0.5)) {
                pulseScale = 1.03
            }
        }
        .onDisappear {
            stopPolling()
        }

        OnboardingFooter(currentStep: state.currentStep)
            .padding(.bottom, VSpacing.lg)
    }

    // MARK: - Subviews

    private func permissionRow(icon: String, label: String, granted: Bool) -> some View {
        HStack {
            VIconView(SFSymbolMapping.icon(forSFSymbol: icon, fallback: .puzzle), size: 14)
                .foregroundColor(granted ? Emerald._500 : VColor.textMuted)
                .frame(width: 24)
            Text(label)
                .font(.system(size: 15))
                .foregroundColor(VColor.textPrimary)
                .textSelection(.enabled)
            Spacer()
            VIconView(granted ? .circleCheck : .circle, size: 16)
                .foregroundColor(granted ? Emerald._500 : VColor.textMuted)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
    }

    private func keyBadge(_ label: String) -> some View {
        Text(label)
            .font(.system(size: 16, weight: .medium, design: .monospaced))
            .foregroundColor(VColor.textPrimary)
            .textSelection(.enabled)
            .padding(.horizontal, VSpacing.xl)
            .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Permissions

    private func checkCurrentPermissions() {
        micGranted = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        speechGranted = SFSpeechRecognizer.authorizationStatus() == .authorized
    }

    private func requestPermissions() {
        // If already requested and denied, open System Settings
        if permissionsRequested {
            if !micGranted {
                openPrivacySettings(for: "Privacy_Microphone")
            } else if !speechGranted {
                openPrivacySettings(for: "Privacy_SpeechRecognition")
            }
            return
        }

        withAnimation {
            permissionsRequested = true
        }

        // Request microphone first
        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        if micStatus == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                Task { @MainActor in
                    self.micGranted = granted
                    // After mic, request speech
                    self.requestSpeechPermission()
                }
            }
        } else {
            micGranted = micStatus == .authorized
            requestSpeechPermission()
        }

        // Start polling for permission changes (user may grant via System Settings)
        startPolling()
    }

    private func requestSpeechPermission() {
        let speechStatus = SFSpeechRecognizer.authorizationStatus()
        if speechStatus == .notDetermined {
            SFSpeechRecognizer.requestAuthorization { status in
                Task { @MainActor in
                    self.speechGranted = status == .authorized
                }
            }
        } else {
            speechGranted = speechStatus == .authorized
        }
    }

    private func startPolling() {
        permissionPollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            Task { @MainActor in
                checkCurrentPermissions()
            }
        }
    }

    private func stopPolling() {
        permissionPollTimer?.invalidate()
        permissionPollTimer = nil
    }

    private func openPrivacySettings(for pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
            NSWorkspace.shared.open(url)
        }
    }
}

#Preview {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: 0) {
            Spacer()
            Image("VellyLogo")
                .resizable()
                .interpolation(.none)
                .aspectRatio(contentMode: .fit)
                .frame(width: 128, height: 128)
                .padding(.bottom, VSpacing.xxl)
            FnKeyStepView(state: {
                let s = OnboardingState()
                s.assistantName = "Assistant"
                s.currentStep = 4
                return s
            }())
        }
    }
    .frame(width: 460, height: 620)
}
