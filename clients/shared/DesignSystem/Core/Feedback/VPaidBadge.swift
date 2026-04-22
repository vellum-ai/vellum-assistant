import SwiftUI

/// Small pill badge marking an integration or feature as paid. Pairs a
/// dollar-sign icon with a "Paid" label on a subtle green background.
public struct VPaidBadge: View {
    public init() {}

    public var body: some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(.circleDollarSign, size: 12)
                .foregroundStyle(VColor.systemPositiveStrong)
            Text("Paid")
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentDefault)
        }
        .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.sm, bottom: VSpacing.xs, trailing: VSpacing.sm))
        .background(VColor.systemPositiveWeak)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Paid integration")
    }
}
