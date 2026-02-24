import VellumAssistantShared
import SwiftUI

struct SessionOverlayView: View {
    @ObservedObject var session: ComputerUseSession

    private let minOverlayWidth: CGFloat = 340
    private let maxOverlayWidth: CGFloat = 560

    private var overlayWidth: CGFloat {
        let length = longestVisibleTextLength
        if length > 220 { return maxOverlayWidth }
        if length > 140 { return 500 }
        if length > 90 { return 420 }
        return minOverlayWidth
    }

    private var longestVisibleTextLength: Int {
        var candidates: [String] = [session.task]
        if let prompt = session.pendingToolPermissionPrompt {
            candidates.append(prompt.toolName)
            candidates.append(prompt.summary)
        }
        if let warning = session.qaRecordingWarningMessage {
            candidates.append(warning)
        }
        switch session.state {
        case .running(_, _, let lastAction, let reasoning):
            candidates.append(lastAction)
            candidates.append(reasoning)
        case .awaitingConfirmation(let reason):
            candidates.append(reason)
        case .completed(let summary, _):
            candidates.append(summary)
        case .responded(let answer, _):
            candidates.append(answer)
        case .failed(let reason):
            candidates.append(reason)
        case .idle, .thinking, .paused, .cancelled:
            break
        }
        return candidates.map(\.count).max() ?? 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md + VSpacing.xxs) {
            // Header
            HStack(spacing: VSpacing.sm) {
                Image(systemName: "cursorarrow.click.2")
                    .foregroundStyle(.blue)
                Text("Vellum is working...")
                    .font(VFont.headline)
                    .lineLimit(1)
            }

            // Task text
            Text(session.task)
                .font(VFont.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Divider()

            // Recording status indicator (QA mode only)
            recordingStatusView

            if let prompt = session.pendingToolPermissionPrompt {
                toolPermissionPromptView(prompt)
                Divider()
            }

            // State-dependent content
            stateContent

            // Controls
            controlButtons
        }
        .padding(14)
        .frame(width: overlayWidth, alignment: .leading)
    }

    private func toolPermissionPromptView(_ prompt: PendingToolPermissionPrompt) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.yellow)
                Text("Permission needed")
                    .font(.caption.bold())
            }

            Text("Tool: \(prompt.toolName) (\(prompt.riskLevel))")
                .font(.caption)
                .foregroundStyle(.primary)

            Text(prompt.summary)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 8) {
                Button("Allow") {
                    session.approveToolPermissionPrompt()
                }
                .buttonStyle(.borderedProminent)
                .tint(.blue)
                .controlSize(.small)

                Button("Deny") {
                    session.denyToolPermissionPrompt()
                }
                .controlSize(.small)
            }
        }
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
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.leading, 6)
                    }
                }
                Text(lastAction)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
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
                        .fixedSize(horizontal: false, vertical: true)
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

        case .failed(let reason):
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.red)
                    .padding(.top, 1)
                ScrollView {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 120)
            }

        case .cancelled:
            Text("Cancelled")
                .font(.caption.bold())
                .foregroundStyle(.orange)
        }
    }

    @ViewBuilder
    private var recordingStatusView: some View {
        if session.qaMode {
            if let warning = session.qaRecordingWarningMessage {
                HStack(alignment: .top, spacing: VSpacing.sm) {
                    Circle()
                        .fill(VColor.error)
                        .frame(width: 8, height: 8)
                        .padding(.top, 3)
                    ScrollView {
                        Text(warning)
                            .font(VFont.caption)
                            .foregroundColor(VColor.error)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 60)
                }
                .padding(.horizontal, VSpacing.xs)
            } else if session.isRecordingActive {
                HStack(spacing: VSpacing.sm) {
                    Circle()
                        .fill(VColor.success)
                        .frame(width: 8, height: 8)
                    Text("Recording")
                        .font(VFont.caption)
                        .foregroundColor(VColor.success)
                }
                .padding(.horizontal, VSpacing.xs)
            } else if session.requiresRecording {
                HStack(spacing: VSpacing.sm) {
                    Circle()
                        .fill(VColor.warning)
                        .frame(width: 8, height: 8)
                    Text("Recording required \u{2014} waiting...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.warning)
                }
                .padding(.horizontal, VSpacing.xs)
            } else {
                switch session.state {
                case .idle, .running(step: 0, _, _, _):
                    HStack(spacing: VSpacing.sm) {
                        ProgressView()
                            .controlSize(.mini)
                        Text("Recording starting...")
                            .font(VFont.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, VSpacing.xs)
                default:
                    EmptyView()
                }
            }
        }
    }

    @ViewBuilder
    private var controlButtons: some View {
        switch session.state {
        case .running, .thinking:
            HStack(spacing: 8) {
                undoButton
                autoApproveButton
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

    private var autoApproveButton: some View {
        Button {
            session.autoApproveTools.toggle()
        } label: {
            Label(
                session.autoApproveTools ? "Auto-approve" : "Auto-approve",
                systemImage: session.autoApproveTools ? "checkmark.shield.fill" : "shield"
            )
        }
        .buttonStyle(.bordered)
        .tint(session.autoApproveTools ? .green : nil)
        .controlSize(.small)
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
