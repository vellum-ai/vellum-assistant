import SwiftUI
import VellumAssistantShared

@MainActor
struct ToolSelectionView: View {
    @Binding var selectedTools: Set<String>
    var onContinue: () -> Void
    var onSkip: () -> Void

    @State private var showTitle = false
    @State private var showGrid = false
    @State private var showFooter = false

    private static let allItems: [ToolItem] = {
        var items = ToolItem.allTools
        items.append(ToolItem(id: "other", label: "Something else", logoKey: "other"))
        return items
    }()

    private let columns = Array(repeating: GridItem(.flexible(), spacing: VSpacing.sm), count: 4)

    var body: some View {
        VStack(spacing: 0) {
            // Header
            Text("What do you use?")
                .font(VFont.titleLarge)
                .foregroundStyle(VColor.contentDefault)
                .opacity(showTitle ? 1 : 0)
                .offset(y: showTitle ? 0 : 8)
                .padding(.bottom, VSpacing.md)

            Text("Tell me what you use and I'll tailor what I do for you. No connections or logins right now — that comes later when you want it.")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .opacity(showTitle ? 1 : 0)
                .offset(y: showTitle ? 0 : 8)
                .padding(.horizontal, VSpacing.xxl)
                .padding(.bottom, VSpacing.xxl)

            // Tool grid
            LazyVGrid(columns: columns, spacing: VSpacing.sm) {
                ForEach(Self.allItems) { item in
                    toolTile(item)
                }
            }
            .padding(.horizontal, VSpacing.xxl)
            .opacity(showGrid ? 1 : 0)
            .offset(y: showGrid ? 0 : 12)

            Spacer()

            // Footer
            VStack(spacing: VSpacing.sm) {
                VButton(
                    label: selectedTools.isEmpty
                        ? "Continue"
                        : "Continue \u{00B7} \(selectedTools.count) selected",
                    style: .primary,
                    isFullWidth: true
                ) {
                    onContinue()
                }

                VButton(label: "I'll set this up later", style: .ghost, tintColor: VColor.contentTertiary) {
                    onSkip()
                }
            }
            .padding(.horizontal, VSpacing.xxl)
            .padding(.bottom, VSpacing.xxl)
            .opacity(showFooter ? 1 : 0)
            .offset(y: showFooter ? 0 : 12)
        }
        .onAppear {
            withAnimation(VAnimation.slow.delay(0.1)) {
                showTitle = true
            }
            withAnimation(VAnimation.slow.delay(0.3)) {
                showGrid = true
            }
            withAnimation(VAnimation.slow.delay(0.5)) {
                showFooter = true
            }
        }
    }

    // MARK: - Tool Tile

    @ViewBuilder
    private func toolTile(_ item: ToolItem) -> some View {
        let isSelected = selectedTools.contains(item.id)

        Button {
            withAnimation(VAnimation.fast) {
                if isSelected {
                    selectedTools.remove(item.id)
                } else {
                    selectedTools.insert(item.id)
                }
            }
        } label: {
            VStack(spacing: VSpacing.xs) {
                ZStack(alignment: .topTrailing) {
                    toolIcon(item, size: 32)

                    if isSelected {
                        ZStack {
                            Circle()
                                .fill(VColor.primaryBase)
                                .frame(width: 16, height: 16)

                            VIconView(.check, size: 10)
                                .foregroundStyle(VColor.contentInset)
                        }
                        .offset(x: 4, y: -4)
                    }
                }

                Text(item.label)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .frame(height: 32)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, VSpacing.md)
            .padding(.horizontal, VSpacing.xs)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(isSelected ? VColor.primaryBase.opacity(0.08) : VColor.surfaceLift)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(
                        isSelected ? VColor.primaryBase : VColor.borderElement.opacity(0.5),
                        lineWidth: isSelected ? 1.5 : 1
                    )
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(item.label)
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
        .accessibilityAddTraits(.isToggle)
    }

    @ViewBuilder
    private func toolIcon(_ item: ToolItem, size: CGFloat) -> some View {
        if let nsImage = IntegrationLogoBundle.bundledImage(providerKey: item.logoKey) {
            Image(nsImage: nsImage)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
        } else {
            // Initials fallback for providers without bundled PDFs
            let initials = String(item.label.prefix(2)).uppercased()
            ZStack {
                Circle()
                    .fill(VColor.contentTertiary.opacity(0.3))
                Text(initials)
                    .font(.system(size: size * 0.4, weight: .semibold, design: .rounded))
                    .foregroundStyle(VColor.contentDefault)
            }
            .frame(width: size, height: size)
        }
    }
}
