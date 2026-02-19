import VellumAssistantShared
import SwiftUI

@MainActor
struct HatchingStepView: View {
    @Bindable var state: OnboardingState

    @State private var cliLauncher = CLILauncher()
    @State private var showContent = false
    @State private var eggWobble = false
    @State private var eggCracked = false
    @State private var eggHatched = false
    @State private var crackScale: CGFloat = 0.0
    @State private var wobbleAngle: Double = 0
    @State private var wobbleTimer: Timer?
    @State private var hatchStarted = false

    private var latestLogLine: String {
        state.hatchLogLines.last ?? ""
    }

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()

            eggAnimation
                .padding(.bottom, VSpacing.xl)

            statusText

            logOutput

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .opacity(showContent ? 1 : 0)
        .onAppear {
            withAnimation(.easeOut(duration: 0.5)) {
                showContent = true
            }
            startWobble()
            if !hatchStarted {
                hatchStarted = true
                startHatching()
            }
        }
        .onDisappear {
            wobbleTimer?.invalidate()
        }
        .onChange(of: state.hatchCompleted) { _, completed in
            if completed {
                wobbleTimer?.invalidate()
                withAnimation(.spring(duration: 0.6, bounce: 0.3)) {
                    eggHatched = true
                }
            }
        }
        .onChange(of: state.hatchFailed) { _, failed in
            if failed {
                wobbleTimer?.invalidate()
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
        Text(state.hatchFailed ? "\u{1F480}" : eggCracked ? "\u{1F423}" : "\u{1F95A}")
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

    private var statusText: some View {
        VStack(spacing: VSpacing.sm) {
            if state.hatchFailed {
                Text("Hatching failed")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundColor(VColor.textPrimary)
            } else if state.hatchCompleted {
                Text("Your assistant has hatched!")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundColor(VColor.textPrimary)
            } else {
                Text("Hatching\u{2026}")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundColor(VColor.textPrimary)

                Text(state.cloudProvider == "local"
                     ? "Setting up your local assistant"
                     : "Setting up your assistant on \(state.cloudProvider.uppercased())")
                    .font(.system(size: 14))
                    .foregroundColor(VColor.textSecondary)
            }
        }
    }

    // MARK: - Log Output

    private var logOutput: some View {
        VStack(spacing: VSpacing.xs) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(state.hatchLogLines.enumerated()), id: \.offset) { index, line in
                            Text(line)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundColor(VColor.textMuted)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(index)
                        }
                    }
                    .padding(VSpacing.sm)
                }
                .frame(maxWidth: 380, maxHeight: 140)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .fill(adaptiveColor(
                            light: Color(nsColor: NSColor(red: 0.95, green: 0.95, blue: 0.97, alpha: 1)),
                            dark: VColor.surface.opacity(0.3)
                        ))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                )
                .onChange(of: state.hatchLogLines.count) { _, _ in
                    if let last = state.hatchLogLines.indices.last {
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(last, anchor: .bottom)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, VSpacing.xxl)
        .padding(.top, VSpacing.md)
    }

    // MARK: - Wobble

    private func startWobble() {
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

    // MARK: - Hatching

    private func startHatching() {
        let apiKey = APIKeyManager.getKey() ?? ""

        let config = CLILauncher.RemoteHatchConfig(
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

        Task.detached { [config] in
            do {
                try await cliLauncher.runRemoteHatch(config: config) { line in
                    Task { @MainActor in
                        state.hatchLogLines.append(line)
                        if !eggCracked && state.hatchLogLines.count > 3 {
                            withAnimation(.spring(duration: 0.4)) {
                                eggCracked = true
                            }
                        }
                    }
                }
                await MainActor.run {
                    state.hatchCompleted = true
                }
            } catch {
                await MainActor.run {
                    state.hatchLogLines.append("Error: \(error.localizedDescription)")
                    state.hatchFailed = true
                }
            }
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
            s.hatchLogLines = [
                "Creating new assistant: vellum-abc123",
                "Species: vellum",
                "Cloud: GCP",
                "Project: my-project",
                "Zone: us-central1-a",
                "Creating instance with startup script...",
            ]
            return s
        }())
    }
    .frame(width: 460, height: 620)
}
