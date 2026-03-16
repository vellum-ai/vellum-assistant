import SwiftUI

/// Slack-style conversation indicator for a subagent, rendered below the parent message.
///
/// Looks like Slack's "3 replies  Last reply 2m ago" bar with:
/// - A vertical connecting line on the left linking it visually to the parent message
/// - Subagent icon, label, status, reply preview, and reply count
/// - Clicking opens the conversation detail in the side panel (like Slack opens thread panel)
///
/// This replaces SubagentStatusChip with richer conversation-style affordances.
public struct SubagentConversationView: View {
    let subagent: SubagentInfo
    let events: [SubagentEventItem]
    var onAbort: (() -> Void)?
    var onTap: (() -> Void)?

    @State private var isHovered: Bool = false

    private var isRunning: Bool { !subagent.isTerminal }

    private var statusColor: Color {
        switch subagent.status {
        case .completed: return VColor.systemPositiveStrong
        case .failed, .aborted: return VColor.systemNegativeStrong
        default: return VColor.systemPositiveStrong
        }
    }

    private var statusIcon: VIcon {
        switch subagent.status {
        case .completed: return .circleCheck
        case .failed: return .circleX
        case .aborted: return .circleStop
        default: return .circleDot
        }
    }

    /// Count of visible steps (text + toolUse + error, excluding toolResults).
    private var replyCount: Int {
        events.filter { if case .toolResult = $0.kind { return false }; return true }.count
    }

    /// Preview text from the last meaningful event.
    private var lastReplyPreview: String? {
        let meaningful = events.reversed().first { event in
            switch event.kind {
            case .toolResult: return false
            default: return true
            }
        }
        guard let event = meaningful else { return nil }
        switch event.kind {
        case .text:
            let line = event.content.components(separatedBy: .newlines).first ?? event.content
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            return trimmed.count > 60 ? String(trimmed.prefix(57)) + "..." : trimmed
        case .toolUse(let name):
            return toolActionDescription(name: name, input: event.content)
        case .error:
            let line = event.content.components(separatedBy: .newlines).first ?? event.content
            return line.count > 60 ? String(line.prefix(57)) + "..." : line
        default:
            return nil
        }
    }

    public init(subagent: SubagentInfo, events: [SubagentEventItem], onAbort: (() -> Void)? = nil, onTap: (() -> Void)? = nil) {
        self.subagent = subagent
        self.events = events
        self.onAbort = onAbort
        self.onTap = onTap
    }

    public var body: some View {
        threadContent(phase: 0)
    }

    @ViewBuilder
    private func threadContent(phase: Int) -> some View {
        HStack(alignment: .center, spacing: 0) {
            // L-shaped connector: vertical line from parent → curves right into the thread bar
            LConnector()
                .stroke(statusColor.opacity(0.4), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .frame(width: 14, height: 28)
                .padding(.trailing, VSpacing.xs)

            // Thread indicator content
            threadBar(phase: phase)
        }
    }

    // MARK: - Thread Bar

    private func threadBar(phase: Int) -> some View {
        HStack(spacing: VSpacing.sm) {
            // Label (clickable, turns blue on hover like Slack)
            Text(subagent.label)
                .font(VFont.captionMedium)
                .foregroundColor(isHovered ? VColor.primaryBase : VColor.contentDefault)

            // Status icon
            VIconView(statusIcon, size: 9)
                .foregroundColor(statusColor)

            // Animated dots while running
            if isRunning {
                animatedDots(phase: phase)
            }

            Spacer(minLength: VSpacing.xs)

            // Reply count (like Slack's "3 replies")
            if replyCount > 0 {
                Text("\(replyCount) repl\(replyCount == 1 ? "y" : "ies")")
                    .font(VFont.captionMedium)
                    .foregroundColor(isHovered ? VColor.primaryBase : VColor.systemPositiveStrong)
            } else if isRunning {
                Text("Working...")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                    .italic()
            }

            // Abort button
            if isRunning, let onAbort {
                VIconView(.x, size: 9)
                    .foregroundColor(VColor.contentTertiary)
                    .padding(VSpacing.xs)
                    .contentShape(Rectangle())
                    .highPriorityGesture(TapGesture().onEnded { onAbort() })
                    .accessibilityAddTraits(.isButton)
                    .accessibilityLabel("Abort subagent")
            }

            // View thread arrow
            VIconView(.chevronRight, size: 9)
                .foregroundColor(isHovered ? VColor.primaryBase : VColor.contentTertiary)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(isHovered ? VColor.surfaceBase.opacity(0.5) : VColor.surfaceBase.opacity(0.2))
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .strokeBorder(isHovered ? statusColor.opacity(0.3) : Color.clear, lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture { onTap?() }
        .onHover { hovering in
            isHovered = hovering
        }
        .pointerCursor()
        .accessibilityLabel("Conversation: \(subagent.label)")
        .accessibilityHint("Opens conversation detail panel")
        .accessibilityAddTraits(.isButton)
    }

    // MARK: - Animated Dots

    private func animatedDots(phase _: Int) -> some View {
        HStack(spacing: 2) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(VColor.contentSecondary)
                    .frame(width: 4, height: 4)
                    .phaseAnimator([0, 1, 2]) { content, phase in
                        content.opacity(phase == index ? 1.0 : 0.3)
                    } animation: { _ in
                        .easeInOut(duration: 0.4)
                    }
            }
        }
    }

    // MARK: - Tool Helpers

    private func toolActionDescription(name: String, input: String) -> String {
        let shortInput: String = {
            guard !input.isEmpty else { return "" }
            let lastComponent = URL(fileURLWithPath: input).lastPathComponent
            return lastComponent.isEmpty ? input : lastComponent
        }()

        switch name.lowercased() {
        case "read", "file_read":
            return shortInput.isEmpty ? "Read a file" : "Read \(shortInput)"
        case "edit", "file_edit":
            return shortInput.isEmpty ? "Edited a file" : "Edited \(shortInput)"
        case "write", "file_write":
            return shortInput.isEmpty ? "Created a file" : "Created \(shortInput)"
        case "bash":
            return input.isEmpty ? "Ran a command" : "Ran \(truncated(input, to: 50))"
        case "glob":
            return input.isEmpty ? "Searched for files" : "Found \(truncated(input, to: 50))"
        case "grep":
            return input.isEmpty ? "Searched files" : "Searched for \"\(truncated(input, to: 40))\""
        case "web_search", "websearch":
            return input.isEmpty ? "Searched the web" : "Searched \"\(truncated(input, to: 40))\""
        case "web_fetch", "webfetch":
            if let host = URL(string: input)?.host { return "Fetched \(host)" }
            return "Fetched a URL"
        case "task":
            return input.isEmpty ? "Ran an agent" : "Ran agent: \(truncated(input, to: 40))"
        default:
            return name
                .replacingOccurrences(of: "_", with: " ")
                .split(separator: " ")
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    private func truncated(_ s: String, to length: Int) -> String {
        s.count > length ? String(s.prefix(length - 1)) + "…" : s
    }
}

// MARK: - Subagent Events Reader

/// Thin wrapper that isolates `SubagentDetailStore` observation from the
/// parent `MessageListView`. Each reader resolves the per-subagent
/// `SubagentState` and reads its `events` property, so observation is
/// per-subagent: only this reader invalidates when this subagent's data
/// changes. The parent message list is untouched.
public struct SubagentEventsReader: View {
    var store: SubagentDetailStore
    let subagent: SubagentInfo
    var onAbort: (() -> Void)?
    var onTap: (() -> Void)?

    public init(store: SubagentDetailStore, subagent: SubagentInfo, onAbort: (() -> Void)? = nil, onTap: (() -> Void)? = nil) {
        self.store = store
        self.subagent = subagent
        self.onAbort = onAbort
        self.onTap = onTap
    }

    public var body: some View {
        let state = store.subagentStates[subagent.id]
        SubagentConversationView(
            subagent: subagent,
            events: state?.events ?? [],
            onAbort: onAbort,
            onTap: onTap
        )
    }
}

// MARK: - L-Shaped Connector

/// Draws a smooth L-shaped path: vertical line down from top-left, then curves
/// right toward the thread bar. Uses a quarter-circle arc for a polished look.
private struct LConnector: Shape {
    func path(in rect: CGRect) -> Path {
        let radius: CGFloat = 6
        var path = Path()
        path.move(to: CGPoint(x: 1, y: 0))
        path.addLine(to: CGPoint(x: 1, y: rect.midY - radius))
        path.addArc(
            center: CGPoint(x: 1 + radius, y: rect.midY - radius),
            radius: radius,
            startAngle: .degrees(180),
            endAngle: .degrees(90),
            clockwise: true
        )
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        return path
    }
}
