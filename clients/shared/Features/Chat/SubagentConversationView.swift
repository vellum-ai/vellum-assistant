import SwiftUI

// MARK: - Subagent Group Container

/// Collapsible container that groups multiple subagents into a single inline
/// transcript element. Modeled after `AssistantProgressView`'s expandable
/// card pattern: a header summarizes the group ("3 subagents running") and
/// expanding reveals individual rows. Tapping a row opens its detail panel.
public struct SubagentGroupContainer: View {
    let subagents: [SubagentInfo]
    var onAbort: ((String) -> Void)?
    var onTap: ((String) -> Void)?
    var avatarProvider: ((String) -> NSImage?)?

    @State private var isExpanded: Bool

    public init(
        subagents: [SubagentInfo],
        onAbort: ((String) -> Void)? = nil,
        onTap: ((String) -> Void)? = nil,
        avatarProvider: ((String) -> NSImage?)? = nil
    ) {
        self.subagents = subagents
        self.onAbort = onAbort
        self.onTap = onTap
        self.avatarProvider = avatarProvider
        _isExpanded = State(initialValue: !subagents.allSatisfy(\.isTerminal))
    }

    private var allTerminal: Bool { subagents.allSatisfy(\.isTerminal) }

    private var failedCount: Int {
        subagents.filter { $0.status == .failed || $0.status == .aborted }.count
    }

    private var headlineText: String {
        let count = subagents.count
        if allTerminal {
            if failedCount > 0 {
                return "Completed \(count) subagent\(count == 1 ? "" : "s") (\(failedCount) failed)"
            }
            return "Completed \(count) subagent\(count == 1 ? "" : "s")"
        }
        let running = subagents.filter({ !$0.isTerminal }).count
        return "\(running) subagent\(running == 1 ? "" : "s") running"
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerRow

            if isExpanded {
                expandedContent
                    .padding(.bottom, VSpacing.xs)
            }
        }
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .animation(VAnimation.fast, value: isExpanded)
        .textSelection(.disabled)
        .onChange(of: allTerminal) { _, isTerminal in
            if isTerminal {
                withAnimation(VAnimation.fast) { isExpanded = false }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Subagent group: \(headlineText)")
    }

    // MARK: - Header

    private var headerRow: some View {
        Button(action: {
            withAnimation(VAnimation.fast) {
                isExpanded.toggle()
            }
        }) {
            HStack(spacing: VSpacing.sm) {
                if allTerminal {
                    VIconView(failedCount > 0 ? .triangleAlert : .circleCheck, size: 12)
                        .foregroundStyle(failedCount > 0 ? VColor.systemNegativeStrong : VColor.primaryBase)
                } else {
                    VBusyIndicator(size: 8)
                }

                Text(headlineText)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer()

                VIconView(isExpanded ? .chevronUp : .chevronDown, size: 9)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.sm, bottom: VSpacing.xs, trailing: VSpacing.sm))
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(isExpanded ? "Collapse subagent list" : "Expand subagent list")
    }

    // MARK: - Expanded Content

    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(subagents) { subagent in
                SubagentGroupRow(
                    subagent: subagent,
                    avatarImage: avatarProvider?(subagent.id),
                    onAbort: { onAbort?(subagent.id) },
                    onTap: { onTap?(subagent.id) }
                )
            }
        }
    }
}

// MARK: - Subagent Group Row

/// A single subagent row within a `SubagentGroupContainer`. Shows the
/// subagent's label with a status indicator. Tapping opens the detail panel.
public struct SubagentGroupRow: View {
    let subagent: SubagentInfo
    var avatarImage: NSImage?
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

    private var statusLabel: String {
        switch subagent.status {
        case .completed: return "Completed"
        case .failed: return "Failed"
        case .aborted: return "Aborted"
        case .running: return "Working…"
        case .awaitingInput: return "Awaiting input"
        case .pending: return "Pending"
        case .unknown: return ""
        }
    }

    public init(subagent: SubagentInfo, avatarImage: NSImage? = nil, onAbort: (() -> Void)? = nil, onTap: (() -> Void)? = nil) {
        self.subagent = subagent
        self.avatarImage = avatarImage
        self.onAbort = onAbort
        self.onTap = onTap
    }

    public var body: some View {
        HStack(spacing: VSpacing.sm) {
            if let avatarImage {
                VAvatarImage(image: avatarImage, size: 20, showBorder: false)
            } else {
                VIconView(statusIcon, size: 9)
                    .foregroundStyle(statusColor)
            }

            Text(subagent.label)
                .font(VFont.labelDefault)
                .foregroundStyle(isHovered ? VColor.primaryBase : VColor.contentDefault)
                .lineLimit(1)
                .truncationMode(.tail)

            if isRunning {
                SubagentAnimatedDots()
            }

            Spacer(minLength: VSpacing.xs)

            if !isRunning {
                Text(statusLabel)
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
            }

            if isRunning, let onAbort {
                VIconView(.square, size: 9)
                    .foregroundStyle(VColor.contentTertiary)
                    .padding(VSpacing.xs)
                    .contentShape(Rectangle())
                    .highPriorityGesture(TapGesture().onEnded { onAbort() })
                    .accessibilityAddTraits(.isButton)
                    .accessibilityLabel("Stop subagent")
                    .accessibilityAction { onAbort() }
            }

            VIconView(.chevronRight, size: 9)
                .foregroundStyle(isHovered ? VColor.primaryBase : VColor.contentTertiary)
        }
        .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.sm + VSpacing.sm, bottom: VSpacing.xs, trailing: VSpacing.xs + VSpacing.xs))
        .background(isHovered ? VColor.surfaceActive : Color.clear)
        .contentShape(Rectangle())
        .onTapGesture { onTap?() }
        .pointerCursor { isHovered = $0 }
        .accessibilityLabel("Subagent: \(subagent.label), \(statusLabel)")
        .accessibilityHint("Opens subagent detail panel")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { onTap?() }
    }
}

// MARK: - Shared Animated Dots

/// Reusable animated dots indicator for subagent running state.
private struct SubagentAnimatedDots: View {
    var body: some View {
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
}
