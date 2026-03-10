import VellumAssistantShared
import SwiftUI

@MainActor
struct HatchingStepView: View {
    @Bindable var state: OnboardingState

    @State private var cliLauncher = AssistantCli()
    @State private var showContent = false
    @State private var eggWobble = false
    @State private var eggCracked = false
    @State private var eggHatched = false
    @State private var crackScale: CGFloat = 0.0
    @State private var wobbleAngle: Double = 0
    @State private var wobbleTimer: Timer?
    @State private var hatchStarted = false
    @State private var crackTime: Date?
    @State private var hatchStartTime: Date?
    @State private var elapsedTime: TimeInterval = 0
    @State private var elapsedTimer: Timer?
    @State private var cliFinished = false
    @State private var failureReason: String?

    private var isLocalFlow: Bool {
        state.cloudProvider == "local" || state.cloudProvider.isEmpty
    }

    /// Expected duration in seconds: local flows are fast, cloud flows take longer.
    private var expectedDuration: TimeInterval {
        isLocalFlow ? 45.0 : 180.0
    }

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()

            eggAnimation
                .padding(.bottom, VSpacing.xl)

            statusText

            if state.hatchFailed {
                failureButtons
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .opacity(showContent ? 1 : 0)
        .onAppear {
            withAnimation(.easeOut(duration: 0.5)) {
                showContent = true
            }
            startWobble()
            hatchStartTime = Date()
            startElapsedTimer()
            if !hatchStarted {
                hatchStarted = true
                startHatching()
            }
        }
        .onDisappear {
            wobbleTimer?.invalidate()
            elapsedTimer?.invalidate()
        }
        .onChange(of: state.hatchCompleted) { _, completed in
            if completed {
                wobbleTimer?.invalidate()
                elapsedTimer?.invalidate()
                withAnimation(.spring(duration: 0.6, bounce: 0.3)) {
                    eggHatched = true
                }
            }
        }
        .onChange(of: state.hatchFailed) { _, failed in
            if failed {
                wobbleTimer?.invalidate()
                elapsedTimer?.invalidate()
            }
        }
    }

    // MARK: - Egg Animation

    private var eggAnimation: some View {
        ZStack {
            if eggHatched && !state.hatchFailed {
                hatchedChick
                    .transition(.scale.combined(with: .opacity))
            } else {
                wobbleEgg
                    .transition(.opacity)
            }
        }
        .frame(width: 120, height: 120)
        .animation(.spring(duration: 0.5), value: eggHatched)
    }

    private var wobbleEgg: some View {
        Text(state.hatchFailed ? "\u{1FAE0}" : eggCracked ? "\u{1F423}" : "\u{1F95A}")
            .font(.system(size: 72))
            .rotationEffect(.degrees(wobbleAngle))
            .scaleEffect(eggCracked ? 1.1 : 1.0)
            .animation(.spring(duration: 0.3), value: eggCracked)
    }

    private var hatchedChick: some View {
        Text("\u{1F425}")
            .font(.system(size: 72))
            .scaleEffect(1.2)
    }

    // MARK: - Status Text

    private var isCustomHardware: Bool {
        state.cloudProvider == "customHardware"
    }

    private var statusText: some View {
        VStack(spacing: VSpacing.sm) {
            if state.hatchFailed {
                Text("Something went wrong")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundColor(VColor.textPrimary)
                if let reason = failureReason {
                    Text(reason)
                        .font(.system(size: 14))
                        .foregroundColor(VColor.textSecondary)
                }
            } else if state.hatchCompleted {
                Text(isCustomHardware ? "Your assistant is paired!" : "Your assistant has hatched!")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundColor(VColor.textPrimary)
            } else if isCustomHardware {
                Text("Pairing\u{2026}")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundColor(VColor.textPrimary)
            } else {
                Text("Hatching...")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundColor(VColor.textPrimary)
                Text("Getting your assistant ready\u{2026}")
                    .font(.system(size: 14))
                    .foregroundColor(VColor.textSecondary)
                Text("Your assistant will ask a few quick questions to get started.\nThis usually takes less than a minute.")
                    .font(.system(size: 13))
                    .foregroundColor(VColor.textMuted)
            }
        }
    }

    // MARK: - Failure Buttons

    private var failureButtons: some View {
        VStack(spacing: VSpacing.sm) {
            OnboardingButton(title: "Try Again", style: .primary) {
                retryHatch()
            }

            OnboardingButton(title: "Go Back", style: .tertiary) {
                goBack()
            }
        }
        .frame(maxWidth: 280)
        .padding(.top, VSpacing.xs)
    }

    private func goBack() {
        state.isHatching = false
        state.hatchFailed = false
        state.hatchLogLines = []
        hatchStarted = false
        failureReason = nil
    }

    private func retryHatch() {
        hatchStarted = false
        failureReason = nil
        state.resetForRetry()
    }

    // MARK: - Timers

    private func startElapsedTimer() {
        elapsedTimer?.invalidate()
        elapsedTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            Task { @MainActor in
                guard let start = hatchStartTime else { return }
                elapsedTime = Date().timeIntervalSince(start)
                // Time-based egg crack: crack at 50% of expected duration
                if !eggCracked && elapsedTime >= expectedDuration * 0.5 {
                    triggerCrack()
                }
            }
        }
    }

    // MARK: - Crack Logic

    private func triggerCrack() {
        guard !eggCracked else { return }
        withAnimation(.spring(duration: 0.4)) {
            eggCracked = true
        }
        crackTime = Date()
    }

    /// Called when the CLI process finishes successfully. Applies the post-crack
    /// minimum delay before signaling completion to OnboardingFlowView.
    private func handleHatchSuccess() {
        cliFinished = true

        if !eggCracked {
            // Fast-path: CLI finished before time-based crack fired.
            // Force crack immediately, then wait 2s before completing.
            triggerCrack()
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                state.hatchCompleted = true
            }
        } else if let crack = crackTime {
            let elapsed = Date().timeIntervalSince(crack)
            if elapsed < 2.0 {
                // Crack happened less than 2s ago; wait the remaining time.
                let remaining = 2.0 - elapsed
                DispatchQueue.main.asyncAfter(deadline: .now() + remaining) {
                    state.hatchCompleted = true
                }
            } else {
                // Crack happened 2s+ ago; complete immediately.
                state.hatchCompleted = true
            }
        } else {
            state.hatchCompleted = true
        }
    }

    // MARK: - Wobble

    private func startWobble() {
        wobbleTimer?.invalidate()
        wobbleTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
            Task { @MainActor in
                withAnimation(.easeInOut(duration: 0.25)) {
                    wobbleAngle = Double.random(in: -8...8)
                }
                try? await Task.sleep(nanoseconds: 250_000_000)
                withAnimation(.easeInOut(duration: 0.25)) {
                    wobbleAngle = 0
                }
            }
        }
    }

    // MARK: - Hatching / Pairing

    private func startHatching() {
        if isCustomHardware {
            startPairing()
        } else {
            startRemoteHatch()
        }
    }

    private func startRemoteHatch() {
        let apiKey = APIKeyManager.getKey(for: "anthropic") ?? ""

        let config = AssistantCli.RemoteHatchConfig(
            remote: state.cloudProvider,
            gcpProjectId: state.gcpProjectId,
            gcpZone: state.gcpZone,
            gcpServiceAccountKey: state.gcpServiceAccountKey,
            awsRoleArn: state.awsRoleArn,
            sshHost: state.sshHost,
            sshUser: state.sshUser,
            sshPrivateKey: state.sshPrivateKey,
            anthropicApiKey: apiKey
        )

        Task {
            do {
                try await cliLauncher.runRemoteHatch(config: config) { line in
                    Task { @MainActor in
                        state.hatchLogLines.append(line)
                    }
                }
                handleHatchSuccess()
            } catch {
                state.hatchLogLines.append("Error: \(error.localizedDescription)")
                failureReason = friendlyErrorMessage(from: error)
                state.hatchFailed = true
            }
        }
    }

    private func startPairing() {
        Task {
            do {
                try await cliLauncher.runPair(qrCodeImageData: state.customQRCodeImageData) { line in
                    Task { @MainActor in
                        state.hatchLogLines.append(line)
                    }
                }
                handleHatchSuccess()
            } catch {
                state.hatchLogLines.append("Error: \(error.localizedDescription)")
                failureReason = friendlyErrorMessage(from: error)
                state.hatchFailed = true
            }
        }
    }

    // MARK: - Error Mapping

    private func friendlyErrorMessage(from error: Error) -> String {
        let desc = error.localizedDescription.lowercased()
        if desc.contains("connection refused") || desc.contains("econnrefused") {
            return "Could not connect to your assistant"
        } else if desc.contains("timed out") || desc.contains("timeout") {
            return "Setup timed out \u{2014} please try again"
        } else if desc.contains("no such file") || desc.contains("enoent") {
            return "Assistant files could not be found"
        } else if desc.contains("network") || desc.contains("internet") {
            return "Network connection issue"
        } else if desc.contains("permission") || desc.contains("eacces") {
            return "Permission denied"
        } else {
            return error.localizedDescription
        }
    }
}

#Preview {
    ZStack {
        VColor.background.ignoresSafeArea()
        HatchingStepView(state: {
            let s = OnboardingState()
            s.isHatching = true
            s.cloudProvider = "gcp"
            return s
        }())
    }
    .frame(width: 460, height: 620)
}
