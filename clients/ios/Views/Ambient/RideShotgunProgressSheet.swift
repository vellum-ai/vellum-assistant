#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Sheet shown while a Ride Shotgun observation session is in progress.
/// Displays elapsed time, a progress bar, current status, and a stop button.
struct RideShotgunProgressSheet: View {
    @ObservedObject var session: RideShotgunSession
    let onStop: () -> Void
    let onStopEarly: () -> Void

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            // Header
            HStack {
                VIconView(.binoculars, size: 16)
                    .foregroundStyle(VColor.accent)
                    .accessibilityHidden(true)
                Text(headerTitle)
                    .font(VFont.headline)
                    .foregroundStyle(VColor.textPrimary)
                Spacer()
            }

            // Progress bar
            ProgressView(
                value: session.elapsedSeconds,
                total: Double(session.durationSeconds)
            )
            .tint(VColor.accent)
            .accessibilityLabel("Progress: \(Int(session.elapsedSeconds)) of \(session.durationSeconds) seconds")

            // Elapsed time row
            HStack {
                if !session.currentApp.isEmpty {
                    Text(session.currentApp)
                        .font(VFont.caption)
                        .foregroundStyle(VColor.textMuted)
                        .lineLimit(1)
                }
                Spacer()
                Text(elapsedLabel)
                    .font(VFont.caption)
                    .foregroundStyle(VColor.textMuted)
                    .monospacedDigit()
            }

            // Status message
            if !session.statusMessage.isEmpty {
                Text(session.statusMessage)
                    .font(VFont.caption)
                    .foregroundStyle(VColor.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            // Action buttons
            HStack(spacing: VSpacing.md) {
                Button(role: .destructive) {
                    onStop()
                } label: {
                    Text("Cancel")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)

                // Only offer "Done early" while still capturing.
                if session.state == .capturing {
                    Button {
                        onStopEarly()
                    } label: {
                        Text("Done early")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(VColor.accent)
                }
            }
        }
        .padding(VSpacing.xl)
        .presentationDetents([.height(280)])
        .presentationDragIndicator(.visible)
        // Prevent the user from dismissing the sheet by dragging — they must use a button.
        .interactiveDismissDisabled()
    }

    private var headerTitle: String {
        switch session.state {
        case .starting: return "Starting…"
        case .capturing: return "Riding shotgun…"
        case .summarizing: return "Analysing…"
        default: return "Riding shotgun…"
        }
    }

    private var elapsedLabel: String {
        let elapsed = Int(session.elapsedSeconds)
        let total = session.durationSeconds
        let minutes = elapsed / 60
        let seconds = elapsed % 60
        let totalMin = total / 60
        let totalSec = total % 60
        return String(format: "%d:%02d / %d:%02d", minutes, seconds, totalMin, totalSec)
    }
}

#Preview {
    let session = RideShotgunSession(durationSeconds: 180)
    return Color.clear
        .sheet(isPresented: .constant(true)) {
            RideShotgunProgressSheet(session: session, onStop: {}, onStopEarly: {})
        }
}
#endif
