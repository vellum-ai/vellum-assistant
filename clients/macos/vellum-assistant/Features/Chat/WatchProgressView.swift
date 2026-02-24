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
                Image(systemName: isLearnMode ? "antenna.radiowaves.left.and.right" : "eye.fill")
                    .foregroundColor(VColor.accent)
                    .opacity(isPulsing ? 0.4 : 1.0)
                    .animation(
                        Animation.easeInOut(duration: 1.0).repeatForever(autoreverses: true),
                        value: isPulsing
                    )

                Text(isLearnMode ? "Recording network traffic..." : "Watching your workflow...")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)

                Spacer()

                // Stop button — highlighted when idle hint is active
                Button(action: onStop) {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(idleHint ? VColor.accent : VColor.error)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop watching")
            }

            // Progress bar with elapsed/total
            VStack(spacing: VSpacing.xs) {
                ProgressView(value: progress)
                    .tint(VColor.accent)

                HStack {
                    Text("\(elapsedFormatted) / \(totalFormatted)")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    if isLearnMode {
                        Text("\(networkEntryCount) network entries")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                    } else {
                        Text("\(session.captureCount)/\(session.totalExpected) captures")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                    }
                }
            }

            // Idle hint prompt
            if idleHint {
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "checkmark.circle")
                        .foregroundColor(VColor.accent)
                        .font(.system(size: 12))
                    Text("No new activity detected. Ready to stop?")
                        .font(VFont.caption)
                        .foregroundColor(VColor.accent)
                    Spacer()
                }
                .transition(.opacity)
            }

            // Current app badge
            if !session.currentApp.isEmpty {
                HStack {
                    Text(session.currentApp)
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(
                            RoundedRectangle(cornerRadius: VRadius.xs)
                                .fill(VColor.backgroundSubtle)
                        )
                    Spacer()
                }
            }
        }
        .padding(VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surface)
        )
        .onAppear {
            isPulsing = true
        }
    }
}
