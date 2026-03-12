import VellumAssistantShared
import SwiftUI

@MainActor
struct CapabilitiesModalView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.xxl) {
                    sectionView(
                        icon: "sparkles",
                        iconColor: VColor.systemPositiveStrong,
                        title: "What I can do",
                        items: [
                            "Browse the web and search for information",
                            "Read, write, and organize files",
                            "Manage tasks and reminders",
                            "Help with email drafts and replies",
                            "Take actions in apps on your behalf",
                        ]
                    )

                    sectionView(
                        icon: "shield.lefthalf.filled",
                        iconColor: VColor.systemNegativeStrong,
                        title: "What I won\u{2019}t do",
                        items: [
                            "Act without asking when something\u{2019}s irreversible",
                            "Access your accounts without permission \u{2014} I\u{2019}ll always ask first",
                            "Store sensitive information like passwords",
                            "Make decisions that should be yours",
                        ]
                    )

                    sectionView(
                        icon: "car.fill",
                        iconColor: VColor.primaryActive,
                        title: "How control works",
                        items: [
                            "You\u{2019}re always in the driver\u{2019}s seat",
                            "I\u{2019}ll ask before doing anything big",
                            "You can take over anytime",
                            "Say \u{201C}stop\u{201D} or press Escape to halt any action",
                        ]
                    )
                }
                .padding(.horizontal, VSpacing.xxl)
                .padding(.top, VSpacing.xxl)
                .padding(.bottom, VSpacing.lg)
            }

            Divider()
                .background(VColor.borderBase.opacity(0.4))

            VButton(label: "Got it", style: .primary, isFullWidth: true) {
                dismiss()
            }
            .padding(.horizontal, VSpacing.xxl)
            .padding(.vertical, VSpacing.lg)
        }
        .frame(width: 400, height: 480)
        .background(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .fill(.ultraThinMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.xl)
                        .fill(Meadow.panelBackground)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.xl)
                        .stroke(Meadow.panelBorder, lineWidth: 1)
                )
        )
    }

    // MARK: - Section Builder

    private func sectionView(
        icon: String,
        iconColor: Color,
        title: String,
        items: [String]
    ) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            HStack(spacing: VSpacing.sm) {
                VIconView(SFSymbolMapping.icon(forSFSymbol: icon, fallback: .puzzle), size: 14)
                    .foregroundColor(iconColor)
                Text(title)
                    .font(VFont.headline)
                    .foregroundColor(VColor.contentDefault)
            }

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                ForEach(items, id: \.self) { item in
                    HStack(alignment: .top, spacing: VSpacing.sm) {
                        Text("\u{2022}")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentTertiary)
                        Text(item)
                            .font(VFont.body)
                            .foregroundColor(VColor.contentSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.leading, VSpacing.xs)
        }
    }
}

#Preview {
    CapabilitiesModalView()
        .frame(width: 420, height: 560)
}
