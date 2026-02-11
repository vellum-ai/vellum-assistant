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

        case .thinking(let step, let maxSteps):
            VStack(alignment: .leading, spacing: 4) {
                Text("Step \(step) of \(maxSteps)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Thinking...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

        case .running(let step, let maxSteps, let lastAction, let reasoning):
            VStack(alignment: .leading, spacing: 4) {
                Text("Step \(step) of \(maxSteps)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !reasoning.isEmpty {
                    HStack(spacing: 0) {
                        Rectangle()
                            .fill(.blue.opacity(0.4))
                            .frame(width: 3)
                        Text(reasoning)
                            .font(.caption)
                            .foregroundStyle(.primary)
                            .lineLimit(3)
                            .padding(.leading, 6)
                    }
                }
                Text(lastAction)
                    .font(.caption)
                    .foregroundStyle(.secondary)
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

        case .responded(let answer, _):
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "text.bubble.fill")
                        .foregroundStyle(.blue)
                    Text("Response")
                        .font(.caption.bold())
                }
                ScrollView {
                    Text(answer)
                        .font(.caption)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 200)
            }
            .frame(width: 380)

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
        case .running, .thinking:
            HStack(spacing: 8) {
                undoButton
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
            HStack(spacing: 8) {
                undoButton
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

        case .completed, .failed, .cancelled, .responded:
            HStack(spacing: 8) {
                undoButton
                Spacer()
            }

        default:
            EmptyView()
        }
    }

    private var undoButton: some View {
        Button {
            session.undo()
        } label: {
            Label(undoLabel, systemImage: "arrow.uturn.backward")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    private var undoLabel: String {
        session.undoCount > 0 ? "Undo (\(session.undoCount))" : "Undo"
    }
}
