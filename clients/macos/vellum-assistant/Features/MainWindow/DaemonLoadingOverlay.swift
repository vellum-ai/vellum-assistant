import SwiftUI
import VellumAssistantShared

/// Skeleton placeholder shown over the chat area while waiting for the
/// daemon to connect.
struct DaemonLoadingChatSkeleton: View {
    var body: some View {
        ZStack {
            VColor.surfaceBase
                .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
            ChatLoadingSkeleton()
                .padding(VSpacing.lg)
        }
        .accessibilityHidden(true)
    }
}

/// Skeleton thread rows shown in the sidebar while threads are loading.
/// Mimics 5 thread rows matching the height of nav items like "Things".
struct DaemonLoadingThreadsSkeleton: View {
    var body: some View {
        VStack(spacing: SidebarLayoutMetrics.listRowGap) {
            ForEach(0..<5, id: \.self) { _ in
                VSkeletonBone(height: 13)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, VSpacing.xs)
                    .padding(.vertical, SidebarLayoutMetrics.rowVerticalPadding)
                    .frame(minHeight: SidebarLayoutMetrics.rowMinHeight)
                    .padding(.horizontal, VSpacing.sm)
            }
        }
        .accessibilityHidden(true)
    }
}

/// Overlay shown during managed assistant first-launch bootstrap.
/// Displays the pulsing avatar "Waking up..." animation while the daemon
/// connection is being established, and a failure state with retry when
/// the connection times out.
struct DaemonHatchingOverlay: View {
    let failed: Bool
    let onRetry: () -> Void

    @State private var pulseScale: CGFloat = 0.9
    @State private var showContent = false
    @State private var showCharacter = true

    var body: some View {
        ZStack {
            VColor.surfaceBase
                .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))

            VStack(spacing: VSpacing.lg) {
                Spacer()

                characterAnimation
                    .padding(.bottom, VSpacing.xl)

                statusText

                if failed {
                    VButton(label: "Try Again", style: .primary) {
                        onRetry()
                    }
                    .frame(maxWidth: 280)
                    .padding(.top, VSpacing.xs)
                }

                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .opacity(showContent ? 1 : 0)
        }
        .onAppear {
            withAnimation(.easeOut(duration: 0.5)) {
                showContent = true
            }
            startPulse()
        }
        .onChange(of: failed) { _, isFailed in
            if isFailed {
                withAnimation(.easeOut(duration: 0.3)) {
                    showCharacter = false
                }
            } else {
                withAnimation(.easeOut(duration: 0.3)) {
                    showCharacter = true
                }
                startPulse()
            }
        }
    }

    // MARK: - Character Animation

    private var avatarImage: NSImage? {
        let mgr = AvatarAppearanceManager.shared
        if let body = mgr.characterBodyShape,
           let eyes = mgr.characterEyeStyle,
           let color = mgr.characterColor {
            return AvatarCompositor.render(bodyShape: body, eyeStyle: eyes, color: color)
        }
        return mgr.customAvatarImage
    }

    private var characterAnimation: some View {
        ZStack {
            if let image = avatarImage {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 100, height: 100)
                    .scaleEffect(pulseScale)
                    .opacity(showCharacter ? 0.6 : 0)
                    .accessibilityHidden(true)
            }
        }
        .frame(width: 120, height: 120)
    }

    private func startPulse() {
        withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) {
            pulseScale = 1.0
        }
    }

    // MARK: - Status Text

    private var statusText: some View {
        VStack(spacing: VSpacing.sm) {
            if failed {
                Text("Something went wrong")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundColor(VColor.contentDefault)
                Text("Could not connect to your assistant.")
                    .font(.system(size: 14))
                    .foregroundColor(VColor.contentSecondary)
            } else {
                Text("Waking up\u{2026}")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundColor(VColor.contentDefault)
                Text("Getting your assistant ready\u{2026}")
                    .font(.system(size: 14))
                    .foregroundColor(VColor.contentSecondary)
            }
        }
    }
}

#if DEBUG

#endif
