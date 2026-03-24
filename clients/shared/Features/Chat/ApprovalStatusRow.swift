import SwiftUI

/// Determines which icon/color to show in the collapsed approval status row.
public enum ApprovalOutcome: Equatable {
    case approved
    case denied
    case stale
    case timedOut
}

/// Shared collapsed/resolved status row used by both tool confirmation and
/// guardian decision bubbles. Renders a single-line indicator showing the
/// outcome icon and a descriptive label.
public struct ApprovalStatusRow: View {
    public let outcome: ApprovalOutcome
    public let label: String

    public init(outcome: ApprovalOutcome, label: String) {
        self.outcome = outcome
        self.label = label
    }

    public var body: some View {
        HStack(spacing: VSpacing.sm) {
            outcomeIcon

            Text(label)
                .font(VFont.labelDefault)
                .foregroundColor(VColor.contentSecondary)

            Spacer()
        }
    }

    @ViewBuilder
    private var outcomeIcon: some View {
        switch outcome {
        case .approved:
            VIconView(.circleCheck, size: 12)
                .foregroundColor(VColor.systemPositiveStrong)
        case .denied:
            VIconView(.circleX, size: 12)
                .foregroundColor(VColor.systemNegativeStrong)
        case .stale, .timedOut:
            VIconView(.clock, size: 12)
                .foregroundColor(VColor.contentTertiary)
        }
    }
}
