import SwiftUI
import VellumAssistantShared

/// A compact indicator showing that live system audio transcription is active.
/// Includes a pulsing dot and a toggle button to start/stop listening.
struct LiveListeningIndicator: View {
    @ObservedObject var manager: LiveTranscriptManager

    @State private var isPulsing = false

    var body: some View {
        Button(action: { manager.toggleListening() }) {
            HStack(spacing: VSpacing.xs) {
                Circle()
                    .fill(dotColor)
                    .frame(width: 6, height: 6)
                    .scaleEffect(isPulsing && manager.isListening ? 1.3 : 1.0)
                    .animation(
                        manager.isListening
                            ? .easeInOut(duration: 1.0).repeatForever(autoreverses: true)
                            : .default,
                        value: isPulsing
                    )

                Text(labelText)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .background(backgroundFill)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        }
        .buttonStyle(.plain)
        .help(helpText)
        .onAppear {
            isPulsing = manager.isListening
        }
        .onChange(of: manager.isListening) { _, listening in
            isPulsing = listening
        }
    }

    private var labelText: String {
        switch manager.status {
        case .idle:
            return "Listen"
        case .starting:
            return "Starting..."
        case .listening:
            return "Listening"
        case .error:
            return "Error"
        }
    }

    private var dotColor: Color {
        switch manager.status {
        case .idle:
            return VColor.textMuted
        case .starting:
            return VColor.warning
        case .listening:
            return VColor.success
        case .error:
            return VColor.error
        }
    }

    private var backgroundFill: Color {
        manager.isListening ? VColor.accentSubtle : Color.clear
    }

    private var helpText: String {
        switch manager.status {
        case .idle:
            return "Start listening to system audio"
        case .starting:
            return "Starting audio capture..."
        case .listening:
            return "Listening to system audio — click to stop"
        case .error(let msg):
            return "Error: \(msg) — click to retry"
        }
    }
}

#Preview("Idle") {
    LiveListeningIndicator(manager: LiveTranscriptManager())
        .padding()
        .background(VColor.background)
}
