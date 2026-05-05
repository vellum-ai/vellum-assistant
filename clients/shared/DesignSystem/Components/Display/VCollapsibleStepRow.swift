import SwiftUI

// MARK: - VCollapsibleStepRow

/// Visual state for a single collapsible step row.
///
/// The row chrome (status icon, title color) is driven entirely by this enum —
/// callers resolve their domain-specific lifecycle into one of these cases.
public enum VCollapsibleStepRowState: Equatable, Sendable {
    /// Step is in flight (shows busy indicator).
    case running
    /// Step finished successfully (shows success checkmark).
    case succeeded
    /// Step finished but surfaced an error (shows alert icon in negative color).
    case failed
    /// Step was blocked / denied before execution (shows alert icon in tertiary color).
    case denied
}

/// Domain-agnostic collapsible row for a single step inside a larger progress
/// container. Renders a header button (icon + title + optional leading/trailing
/// accessory slots + duration + chevron) that toggles a caller-provided detail
/// body.
///
/// Extracted from `AssistantProgressView.StepDetailRow` so it can be reused
/// across the main-thread chat transcript and the subagent detail panel. The
/// row itself is intentionally stateless — expansion is driven by a
/// `@Binding<Bool>` so callers can back it with whatever storage survives
/// their view-recycling model (e.g. `ProgressCardUIState` for the chat
/// transcript's `LazyVStack`).
///
/// Chat-domain concerns (risk badges, permission chips, rule-editor sheets)
/// stay at the caller level — pass them via the accessory slots and present
/// any sheets on the enclosing view. The row has zero knowledge of tool calls,
/// skills, or confirmations.
///
/// Layout:
/// ```
/// [icon] [title] [leadingAccessory] — spacer — [trailingAccessory] [duration] [chevron]
/// ```
public struct VCollapsibleStepRow<LeadingAccessory: View, TrailingAccessory: View, DetailContent: View>: View {
    private let title: String
    private let state: VCollapsibleStepRowState
    private let startedAt: Date?
    private let completedAt: Date?
    /// When false the chevron is hidden and the header tap is a no-op.
    private let hasDetails: Bool
    @Binding private var isExpanded: Bool
    /// Fired when the row transitions from collapsed to expanded. Callers use
    /// this for lazy rehydration of detail content.
    private let onExpand: (() -> Void)?
    private let leadingAccessory: () -> LeadingAccessory
    private let trailingAccessory: () -> TrailingAccessory
    private let detailContent: () -> DetailContent

    public init(
        title: String,
        state: VCollapsibleStepRowState,
        startedAt: Date? = nil,
        completedAt: Date? = nil,
        hasDetails: Bool,
        isExpanded: Binding<Bool>,
        onExpand: (() -> Void)? = nil,
        @ViewBuilder leadingAccessory: @escaping () -> LeadingAccessory = { EmptyView() },
        @ViewBuilder trailingAccessory: @escaping () -> TrailingAccessory = { EmptyView() },
        @ViewBuilder detailContent: @escaping () -> DetailContent
    ) {
        self.title = title
        self.state = state
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.hasDetails = hasDetails
        self._isExpanded = isExpanded
        self.onExpand = onExpand
        self.leadingAccessory = leadingAccessory
        self.trailingAccessory = trailingAccessory
        self.detailContent = detailContent
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                guard hasDetails else { return }
                withAnimation(VAnimation.fast) { isExpanded.toggle() }
            } label: {
                HStack(spacing: VSpacing.sm) {
                    statusIcon
                        .frame(width: 16)

                    Text(title)
                        .font(VFont.labelDefault)
                        .foregroundStyle(titleColor)
                        .lineLimit(1)
                        .truncationMode(.tail)

                    leadingAccessory()

                    Spacer()

                    // Tighter spacing on the right cluster than the outer HStack
                    // (matches the original `StepDetailRow` layout).
                    HStack(spacing: VSpacing.xs) {
                        trailingAccessory()

                        durationLabel

                        if hasDetails {
                            VIconView(.chevronRight, size: 9)
                                .foregroundStyle(VColor.contentTertiary)
                                .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        }
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .environment(\.isEnabled, true)
            // Leading is `VSpacing.sm + VSpacing.sm` (16pt) rather than `VSpacing.lg`
            // to mirror the sibling `ThinkingStepRow` call site in
            // `AssistantProgressView.swift` and match the pre-refactor
            // `StepDetailRow` layout, which chained two `VSpacing.sm` paddings
            // (8 + 8 = 16pt) on the leading edge and (4 + 4 = 8pt) on the
            // trailing edge.
            .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.sm + VSpacing.sm, bottom: VSpacing.xs, trailing: VSpacing.xs + VSpacing.xs))

            if isExpanded {
                detailContent()
                    .transition(.opacity)
            }
        }
        .animation(VAnimation.fast, value: isExpanded)
        .onChange(of: isExpanded) { _, newValue in
            guard newValue else { return }
            DispatchQueue.main.async {
                onExpand?()
            }
        }
    }

    // MARK: - Subviews

    @ViewBuilder
    private var statusIcon: some View {
        switch state {
        case .succeeded:
            VIconView(.circleCheck, size: 12)
                .foregroundStyle(VColor.primaryBase)
        case .failed:
            VIconView(.circleAlert, size: 12)
                .foregroundStyle(VColor.systemNegativeStrong)
        case .denied:
            VIconView(.circleAlert, size: 12)
                .foregroundStyle(VColor.contentTertiary)
        case .running:
            VBusyIndicator(size: 6)
        }
    }

    private var titleColor: Color {
        switch state {
        case .failed: return VColor.systemNegativeStrong
        case .denied: return VColor.contentTertiary
        case .running, .succeeded: return VColor.contentDefault
        }
    }

    @ViewBuilder
    private var durationLabel: some View {
        // Only render a duration label for finished rows (succeeded/failed/denied).
        // Running rows intentionally show no duration — the enclosing container
        // is responsible for surfacing live progress via other affordances.
        switch state {
        case .running:
            EmptyView()
        case .succeeded, .failed, .denied:
            if let startedAt, let completedAt {
                let seconds = completedAt.timeIntervalSince(startedAt)
                if seconds >= 0.05 {
                    Text(VCollapsibleStepRowDurationFormatter.format(seconds))
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }
        }
    }
}

// MARK: - Duration Formatter

/// Human-readable step-duration formatter shared between the row and any
/// synthetic sibling rows that want to format a duration the same way.
public enum VCollapsibleStepRowDurationFormatter {
    public static func format(_ seconds: TimeInterval) -> String {
        seconds < 60
            ? String(format: "%.1fs", seconds)
            : "\(Int(seconds) / 60)m \(Int(seconds) % 60)s"
    }
}

