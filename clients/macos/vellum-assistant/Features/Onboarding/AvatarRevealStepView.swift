import SwiftUI
import VellumAssistantShared

/// Shows a loading state while avatar generation is in progress, then reveals
/// the generated avatar with a scale/fade animation. Falls back to the
/// initial-letter avatar if generation fails or times out.
@MainActor
struct AvatarRevealStepView: View {
    let assistantName: String
    let daemonClient: DaemonClientProtocol
    var onContinue: () -> Void

    @State private var isGenerating = true
    @State private var generationFailed = false
    @State private var avatarImage: NSImage?
    // Precomputed transparency flag — avoids expensive bitmap analysis during animation frames.
    @State private var avatarIsTransparent = false
    @State private var showAvatar = false
    @State private var showText = false
    @State private var showButton = false
    @State private var pulseOpacity: Double = 0.4
    @State private var generationTask: Task<Void, Never>?

    /// Timeout for avatar generation (30 seconds)
    private let generationTimeout: UInt64 = 30_000_000_000

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()

            // Avatar display area
            ZStack {
                if isGenerating {
                    loadingPlaceholder
                        .transition(.opacity)
                } else {
                    revealedAvatar
                        .transition(.scale(scale: 0.6).combined(with: .opacity))
                }
            }
            .frame(width: 160, height: 160)
            .animation(.spring(duration: 0.8, bounce: 0.3), value: isGenerating)
            .padding(.bottom, VSpacing.md)

            // Status text
            VStack(spacing: VSpacing.sm) {
                if isGenerating {
                    Text("Creating your avatar\u{2026}")
                        .font(.system(size: 24, weight: .regular, design: .serif))
                        .foregroundColor(VColor.contentDefault)
                        .transition(.opacity)

                    Text("This may take a few seconds")
                        .font(.system(size: 14))
                        .foregroundColor(VColor.contentSecondary)
                        .transition(.opacity)
                } else {
                    Text(generationFailed ? "Meet \(assistantName)!" : "Here's your avatar!")
                        .font(.system(size: 24, weight: .regular, design: .serif))
                        .foregroundColor(VColor.contentDefault)
                        .opacity(showText ? 1 : 0)
                        .offset(y: showText ? 0 : 8)

                    if generationFailed {
                        Text("We'll use this for now -- you can generate a custom avatar later.")
                            .font(.system(size: 14))
                            .foregroundColor(VColor.contentSecondary)
                            .multilineTextAlignment(.center)
                            .opacity(showText ? 1 : 0)
                            .offset(y: showText ? 0 : 8)
                    }
                }
            }
            .animation(.easeOut(duration: 0.4), value: isGenerating)

            Spacer()

            // Continue button (shown after reveal)
            if !isGenerating {
                Button(action: { onContinue() }) {
                    Text("Continue")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(VColor.auxWhite)
                        .frame(maxWidth: 280)
                        .padding(.vertical, VSpacing.lg)
                        .background(
                            RoundedRectangle(cornerRadius: VRadius.lg)
                                .fill(VColor.primaryBase)
                        )
                }
                .buttonStyle(.plain)
                .opacity(showButton ? 1 : 0)
                .offset(y: showButton ? 0 : 12)
                .pointerCursor()
            }

            Spacer()
                .frame(height: VSpacing.xxl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            startAvatarGeneration()
        }
        .onDisappear {
            generationTask?.cancel()
        }
    }

    // MARK: - Loading Placeholder

    private var loadingPlaceholder: some View {
        ZStack {
            Circle()
                .fill(VColor.primaryBase.opacity(pulseOpacity))
                .frame(width: 160, height: 160)
                .onAppear {
                    withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) {
                        pulseOpacity = 0.15
                    }
                }

            Text(String(assistantName.prefix(1)).uppercased())
                .font(.system(size: 64, weight: .semibold))
                .foregroundColor(VColor.auxWhite.opacity(0.6))
        }
    }

    // MARK: - Revealed Avatar

    private var revealedAvatar: some View {
        Group {
            if let image = avatarImage {
                VAvatarImage(image: image, size: 160, isTransparent: avatarIsTransparent, showBorder: false)
                    .shadow(color: VColor.primaryBase.opacity(0.3), radius: 12, y: 4)
                    .scaleEffect(showAvatar ? 1.0 : 0.8)
                    .opacity(showAvatar ? 1 : 0)
            }
        }
    }

    // MARK: - Avatar Generation

    /// Maximum time to wait for the daemon connection to become available
    /// before giving up on avatar generation. During first-launch onboarding
    /// the daemon client isn't connected yet (setupDaemonClient runs after
    /// onboarding completes), so we need to establish the connection here.
    private let connectionTimeout: UInt64 = 10_000_000_000

    private func startAvatarGeneration() {
        generationTask = Task {
            // During onboarding the daemon client may not be connected yet.
            // Attempt to connect before sending the generate_avatar request.
            if let client = daemonClient as? DaemonClient, !client.isConnected {
                let connected = await ensureDaemonConnected(client: client)
                if !connected {
                    // Connection failed — show fallback avatar immediately
                    // instead of falling through to the generate request.
                    await MainActor.run {
                        let fallback = AvatarAppearanceManager.buildInitialLetterAvatar(
                            name: assistantName,
                            size: 160
                        )
                        avatarImage = fallback
                        avatarIsTransparent = VAvatarImage.imageHasTransparency(fallback)
                        generationFailed = true

                        withAnimation(.spring(duration: 0.6, bounce: 0.2)) {
                            isGenerating = false
                        }
                        withAnimation(.spring(duration: 0.8, bounce: 0.3).delay(0.2)) {
                            showAvatar = true
                        }
                        withAnimation(.easeOut(duration: 0.5).delay(0.5)) {
                            showText = true
                        }
                        withAnimation(.easeOut(duration: 0.5).delay(0.8)) {
                            showButton = true
                        }
                    }
                    return
                }
            }

            if Task.isCancelled { return }

            let description = "A cute, friendly, work-safe avatar character for an AI assistant named \(assistantName). The style should be warm, approachable, and professional."

            // Set up a response listener before sending the request
            let success = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                var resumed = false

                // Set up timeout
                let timeoutTask = Task {
                    try? await Task.sleep(nanoseconds: generationTimeout)
                    if !resumed {
                        resumed = true
                        continuation.resume(returning: false)
                    }
                }

                // Listen for the response
                if let client = daemonClient as? DaemonClient {
                    client.onGenerateAvatarResponse = { response in
                        timeoutTask.cancel()
                        if !resumed {
                            resumed = true
                            continuation.resume(returning: response.success)
                        }
                    }
                }

                // Send the request
                do {
                    try daemonClient.send(GenerateAvatarRequestMessage(description: description))
                } catch {
                    timeoutTask.cancel()
                    if !resumed {
                        resumed = true
                        continuation.resume(returning: false)
                    }
                }
            }

            if Task.isCancelled { return }

            // Small delay to let the file system settle
            if success {
                try? await Task.sleep(nanoseconds: 500_000_000)
            }

            await MainActor.run {
                if success {
                    // Reload avatar from disk
                    AvatarAppearanceManager.shared.reloadAvatar()
                    let image = AvatarAppearanceManager.shared.fullAvatarImage
                    avatarImage = image
                    avatarIsTransparent = VAvatarImage.imageHasTransparency(image)
                    generationFailed = false
                } else {
                    // Use fallback initial-letter avatar
                    let fallback = AvatarAppearanceManager.buildInitialLetterAvatar(
                        name: assistantName,
                        size: 160
                    )
                    avatarImage = fallback
                    avatarIsTransparent = VAvatarImage.imageHasTransparency(fallback)
                    generationFailed = true
                }

                // Animate the reveal sequence
                withAnimation(.spring(duration: 0.6, bounce: 0.2)) {
                    isGenerating = false
                }

                withAnimation(.spring(duration: 0.8, bounce: 0.3).delay(0.2)) {
                    showAvatar = true
                }

                withAnimation(.easeOut(duration: 0.5).delay(0.5)) {
                    showText = true
                }

                withAnimation(.easeOut(duration: 0.5).delay(0.8)) {
                    showButton = true
                }
            }
        }
    }

    /// Tries to establish a daemon connection with a timeout.
    /// Returns `true` if the connection succeeds within the deadline.
    private func ensureDaemonConnected(client: DaemonClient) async -> Bool {
        let connectTask = Task {
            try await client.connect()
        }
        let timeoutTask = Task {
            try await Task.sleep(nanoseconds: connectionTimeout)
            connectTask.cancel()
        }

        do {
            try await connectTask.value
            timeoutTask.cancel()
            return true
        } catch {
            timeoutTask.cancel()
            return false
        }
    }
}
