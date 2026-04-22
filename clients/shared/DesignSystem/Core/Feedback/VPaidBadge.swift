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
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(VColor.systemPositiveWeak)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Paid integration")
    }
}
