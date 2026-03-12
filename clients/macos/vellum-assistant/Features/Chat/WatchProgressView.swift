import SwiftUI
import VellumAssistantShared

struct WatchProgressView: View {
    @ObservedObject var session: WatchSession
    let onStop: () -> Void
    var isLearnMode: Bool = false
    var networkEntryCount: Int = 0
    var idleHint: Bool = false

    @State private var isPulsing = false

    private var progress: Double {
        if isLearnMode {
            // In learn mode the capture loop is skipped, so use time-based progress
            guard session.durationSeconds > 0 else { return 0 }
            return min(session.elapsedSeconds / Double(session.durationSeconds), 1.0)
        }
        guard session.totalExpected > 0 else { return 0 }
        return Double(session.captureCount) / Double(session.totalExpected)
    }

    private var elapsedFormatted: String {
        let minutes = Int(session.elapsedSeconds) / 60
        let seconds = Int(session.elapsedSeconds) % 60
        return String(format: "%d:%02d", minutes, seconds)
    }

    private var totalFormatted: String {
        let minutes = session.durationSeconds / 60
        let seconds = session.durationSeconds % 60
        return String(format: "%d:%02d", minutes, seconds)
    }

    var body: some View {
        VStack(spacing: VSpacing.md) {
            // Pulsing icon + label
            HStack(spacing: VSpacing.sm) {
                VIconView(isLearnMode ? .wifi : .eye, size: 14)
                    .foregroundColor(VColor.primaryBase)
                    .opacity(isPulsing ? 0.4 : 1.0)
                    .animation(
                        Animation.easeInOut(duration: 1.0).repeatForever(autoreverses: true),
                        value: isPulsing
                    )

                Text(isLearnMode ? "Recording network traffic..." : "Watching your workflow...")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)
                    .textSelection(.enabled)

                Spacer()

                // Stop button — highlighted when idle hint is active
                Button(action: onStop) {
                    VIconView(.square, size: 12)
                        .foregroundColor(idleHint ? VColor.primaryBase : VColor.systemNegativeStrong)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop watching")
            }

            // Progress bar with elapsed/total
            VStack(spacing: VSpacing.xs) {
                ProgressView(value: progress)
                    .tint(VColor.primaryBase)

                HStack {
                    Text("\(elapsedFormatted) / \(totalFormatted)")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                        .textSelection(.enabled)
                    Spacer()
                    if isLearnMode {
                        Text("\(networkEntryCount) network entries")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                            .textSelection(.enabled)
                    } else {
                        Text("\(session.captureCount)/\(session.totalExpected) captures")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                            .textSelection(.enabled)
                    }
                }
            }

            // Idle hint prompt
            if idleHint {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.circleCheck, size: 12)
                        .foregroundColor(VColor.primaryBase)
                    Text("No new activity detected. Ready to stop?")
                        .font(VFont.caption)
                        .foregroundColor(VColor.primaryBase)
                        .textSelection(.enabled)
                    Spacer()
                }
                .transition(.opacity)
            }

            // Current app badge
            if !session.currentApp.isEmpty {
                HStack {
                    Text(session.currentApp)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                        .textSelection(.enabled)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(
                            RoundedRectangle(cornerRadius: VRadius.xs)
                                .fill(VColor.surfaceBase)
                        )
                    Spacer()
                }
            }
        }
        .padding(VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surfaceBase)
        )
        .onAppear {
            isPulsing = true
        }
    }
}
