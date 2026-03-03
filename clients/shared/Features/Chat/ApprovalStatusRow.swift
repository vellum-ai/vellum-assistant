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
                .font(.system(size: 12))

            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)

            Spacer()
        }
    }

    @ViewBuilder
    private var outcomeIcon: some View {
        switch outcome {
        case .approved:
            Image(systemName: "checkmark.circle.fill")
                .foregroundColor(VColor.success)
        case .denied:
            Image(systemName: "xmark.circle.fill")
                .foregroundColor(VColor.error)
        case .stale, .timedOut:
            Image(systemName: "clock.fill")
                .foregroundColor(VColor.textMuted)
        }
    }
}
