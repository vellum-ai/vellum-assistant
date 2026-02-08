import SwiftUI

struct SessionOverlayView: View {
    @ObservedObject var session: ComputerUseSession

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header
            HStack(spacing: 6) {
                Image(systemName: "cursorarrow.click.2")
                    .foregroundStyle(.blue)
                Text("vellum-assistant is working...")
                    .font(.headline)
                    .lineLimit(1)
            }

            // Task text
            Text(session.task)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)

            Divider()

            // State-dependent content
            stateContent

            // Controls
            controlButtons
        }
        .padding(14)
        .frame(width: 340, alignment: .leading)
    }

    @ViewBuilder
    private var stateContent: some View {
        switch session.state {
        case .idle:
            Text("Initializing...")
                .foregroundStyle(.secondary)

        case .running(let step, let maxSteps, let lastAction):
            VStack(alignment: .leading, spacing: 4) {
                Text("Step \(step) of \(maxSteps)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(lastAction)
                    .font(.caption)
                    .lineLimit(2)
            }

        case .paused(let step, let maxSteps):
            Text("Paused at step \(step)/\(maxSteps)")
                .font(.caption)
                .foregroundStyle(.orange)

        case .awaitingConfirmation(let reason):
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.yellow)
                    Text("Confirmation needed")
                        .font(.caption.bold())
                }
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                HStack(spacing: 8) {
                    Button("Allow") {
                        session.approveConfirmation()
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.blue)
                    .controlSize(.small)

                    Button("Block") {
                        session.rejectConfirmation()
                    }
                    .controlSize(.small)

                    Button("Stop") {
                        session.cancel()
                    }
                    .buttonStyle(.bordered)
                    .tint(.red)
                    .controlSize(.small)
                }
            }

        case .completed(let summary, let steps):
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Done in \(steps) steps")
                        .font(.caption.bold())
                    Text(summary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }

        case .failed(let reason):
            HStack(spacing: 6) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.red)
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }

        case .cancelled:
            Text("Cancelled")
                .font(.caption.bold())
                .foregroundStyle(.orange)
        }
    }

    @ViewBuilder
    private var controlButtons: some View {
        switch session.state {
        case .running:
            HStack(spacing: 8) {
                Spacer()
                Button("Pause") {
                    session.pause()
                }
                .controlSize(.small)

                Button("Stop") {
                    session.cancel()
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .controlSize(.small)
            }

        case .paused:
            HStack {
                Spacer()
                Button("Resume") {
                    session.resume()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)

                Button("Stop") {
                    session.cancel()
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .controlSize(.small)
            }

        default:
            EmptyView()
        }
    }
}
