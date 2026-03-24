import SwiftUI
import VellumAssistantShared

struct WatchProgressView: View {
    @ObservedObject var session: WatchSession
    let onStop: () -> Void

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
                VIconView(.eye, size: 14)
                    .foregroundColor(VColor.primaryBase)
                    .opacity(isPulsing ? 0.4 : 1.0)
                    .animation(
                        Animation.easeInOut(duration: 1.0).repeatForever(autoreverses: true),
                        value: isPulsing
                    )

                Text("Watching your workflow...")
                    .font(VFont.bodyMediumDefault)
                    .foregroundColor(VColor.contentDefault)
                    .textSelection(.enabled)

                Spacer()

                Button(action: onStop) {
                    VIconView(.square, size: 12)
                        .foregroundColor(VColor.systemNegativeStrong)
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
                        .font(VFont.labelDefault)
                        .foregroundColor(VColor.contentSecondary)
                        .textSelection(.enabled)
                    Spacer()
                    Text("\(session.captureCount)/\(session.totalExpected) captures")
                        .font(VFont.labelDefault)
                        .foregroundColor(VColor.contentSecondary)
                        .textSelection(.enabled)
                }
            }

            // Current app badge
            if !session.currentApp.isEmpty {
                HStack {
                    Text(session.currentApp)
                        .font(VFont.bodyMediumLighter)
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
