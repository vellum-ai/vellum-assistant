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
    @State private var hoveredTool: String?
    @State private var otherExpanded = false
    @State private var otherText = ""
    @FocusState private var otherFieldFocused: Bool

    private let columns = Array(repeating: GridItem(.flexible(), spacing: VSpacing.sm), count: 4)

    private var mainContent: some View {
        VStack(spacing: 0) {
            // Header
            Text("What do you use?")
                .font(VFont.titleLarge)
                .foregroundStyle(VColor.contentDefault)
                .opacity(showTitle ? 1 : 0)
                .offset(y: showTitle ? 0 : 8)
                .padding(.bottom, VSpacing.md)

            Text("This helps me tailor how I assist you. No connections needed — you can set those up later.")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .opacity(showTitle ? 1 : 0)
                .offset(y: showTitle ? 0 : 8)
                .padding(.horizontal, VSpacing.xxl)
                .padding(.bottom, VSpacing.lg)
                .layoutPriority(1)

            // Tool grid
            LazyVGrid(columns: columns, spacing: VSpacing.sm) {
                ForEach(ToolItem.allTools) { item in
                    toolTile(item)
                }

                // "Something else" tile — expands inline
                if !otherExpanded {
                    otherCollapsedTile
                }
            }
            .padding(.horizontal, VSpacing.xxl)
            .opacity(showGrid ? 1 : 0)
            .offset(y: showGrid ? 0 : 12)

            // Expanded "Something else" input — below the grid, full width
            if otherExpanded {
                otherExpandedCard
                    .padding(.horizontal, VSpacing.xxl)
                    .padding(.top, VSpacing.sm)
                    .transition(.opacity)
            }
        }
    }

    private var footer: some View {
        VStack(spacing: VSpacing.sm) {
            VButton(
                label: selectedTools.isEmpty
                    ? "Continue"
                    : "Continue \u{00B7} \(selectedTools.count) selected",
                style: .primary,
                isFullWidth: true,
                isDisabled: selectedTools.isEmpty
            ) {
                onContinue()
            }

            VButton(label: "I'll set this up later", style: .ghost, tintColor: VColor.contentTertiary) {
                onSkip()
            }
        }
        .padding(.horizontal, VSpacing.xxl)
        .opacity(showFooter ? 1 : 0)
        .offset(y: showFooter ? 0 : 12)
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 0) {
                    mainContent

                    footer
                        .padding(.top, VSpacing.xl)
                        .padding(.bottom, VSpacing.xxl)
                }
                .frame(minHeight: geometry.size.height)
                .frame(maxWidth: .infinity)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .onAppear {
            // Restore otherText from selectedTools if resuming
            let otherEntries = selectedTools
                .filter { $0.hasPrefix("other:") }
                .map { String($0.dropFirst(6)) }
                .sorted()
            if !otherEntries.isEmpty {
                otherText = otherEntries.joined(separator: ", ")
                otherExpanded = true
            }
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

    // MARK: - "Something else" collapsed tile

    private var otherCollapsedTile: some View {
        let isSelected = selectedTools.contains(where: { $0 == "other" || $0.hasPrefix("other:") })

        return Button {
            withAnimation(VAnimation.fast) {
                otherExpanded = true
                otherFieldFocused = true
                // Remove plain "other" if it was there; the expanded state will track text
                selectedTools.remove("other")
            }
        } label: {
            VStack(spacing: VSpacing.xs) {
                Spacer(minLength: 0)
                toolIcon(ToolItem(id: "other", label: "Something else", logoKey: "other"), size: 32)
                Text("Something else")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                Spacer(minLength: 0)
            }
            .frame(height: 68)
            .frame(maxWidth: .infinity)
            .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.xs, bottom: VSpacing.xs, trailing: VSpacing.xs))
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(isSelected ? VColor.primaryBase.opacity(0.08) : (hoveredTool == "other" ? VColor.surfaceBase : VColor.surfaceLift))
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(
                        isSelected ? VColor.primaryBase : (hoveredTool == "other" ? VColor.borderElement : VColor.borderElement.opacity(0.5)),
                        lineWidth: isSelected ? 1.5 : 1
                    )
            )
            .overlay(alignment: .topTrailing) {
                if isSelected {
                    ZStack {
                        Circle()
                            .fill(VColor.primaryBase)
                            .frame(width: 16, height: 16)
                        VIconView(.check, size: 10)
                            .foregroundStyle(VColor.contentInset)
                    }
                    .padding(VSpacing.sm)
                }
            }
        }
        .buttonStyle(.plain)
        .pointerCursor(onHover: { hovering in
            withAnimation(VAnimation.fast) {
                hoveredTool = hovering ? "other" : nil
            }
        })
        .accessibilityLabel("Something else")
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
        .accessibilityAddTraits(.isToggle)
    }

    // MARK: - "Something else" expanded card

    private var otherExpandedCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                VIconView(.pencil, size: 14)
                    .foregroundStyle(VColor.contentSecondary)
                Text("Something else")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                Spacer()
                Button {
                    withAnimation(VAnimation.fast) {
                        otherExpanded = false
                        otherText = ""
                        selectedTools = selectedTools.filter { !$0.hasPrefix("other:") && $0 != "other" }
                    }
                } label: {
                    VIconView(.x, size: 12)
                        .foregroundStyle(VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .pointerCursor()
                .accessibilityLabel("Dismiss custom tools")
            }

            VTextField(
                placeholder: "e.g. Trello, Basecamp, Asana...",
                text: $otherText,
                size: .small,
                isFocused: $otherFieldFocused
            )
            .onSubmit {
                commitOtherText()
            }
            .onChange(of: otherText) { _, newValue in
                commitOtherText()
            }

            Text("Separate multiple tools with commas")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)

            // Show typed entries as pills
            if !otherText.trimmingCharacters(in: .whitespaces).isEmpty {
                let entries: [String] = {
                    var seen = Set<String>()
                    return otherText
                        .split(separator: ",")
                        .map { $0.trimmingCharacters(in: .whitespaces) }
                        .filter { !$0.isEmpty && seen.insert($0).inserted }
                }()

                if !entries.isEmpty {
                    WrappingHStack(hSpacing: VSpacing.xs, vSpacing: VSpacing.xs) {
                        ForEach(entries, id: \.self) { entry in
                            Text(entry)
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentInset)
                                .padding(.horizontal, VSpacing.sm)
                                .padding(.vertical, VSpacing.xxs)
                                .background(
                                    RoundedRectangle(cornerRadius: VRadius.pill)
                                        .fill(VColor.primaryBase)
                                )
                        }
                    }
                }
            }
        }
        .padding(VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.primaryBase.opacity(0.08))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.primaryBase, lineWidth: 1.5)
                )
        )
    }

    // MARK: - Commit other text to selectedTools

    private func commitOtherText() {
        // Remove any previous other: entries
        selectedTools = selectedTools.filter { !$0.hasPrefix("other:") && $0 != "other" }

        // Split comma-separated input into individual entries so each custom tool
        // is stored discretely (e.g. "other:Trello", "other:Basecamp").
        let entries = otherText
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }

        for entry in entries {
            selectedTools.insert("other:\(entry)")
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
                Spacer(minLength: 0)
                toolIcon(item, size: 32)
                Text(item.label)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                Spacer(minLength: 0)
            }
            .frame(height: 68)
            .frame(maxWidth: .infinity)
            .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.xs, bottom: VSpacing.xs, trailing: VSpacing.xs))
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(isSelected ? VColor.primaryBase.opacity(0.08) : (hoveredTool == item.id ? VColor.surfaceBase : VColor.surfaceLift))
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(
                        isSelected ? VColor.primaryBase : (hoveredTool == item.id ? VColor.borderElement : VColor.borderElement.opacity(0.5)),
                        lineWidth: isSelected ? 1.5 : 1
                    )
            )
            .overlay(alignment: .topTrailing) {
                if isSelected {
                    ZStack {
                        Circle()
                            .fill(VColor.primaryBase)
                            .frame(width: 16, height: 16)

                        VIconView(.check, size: 10)
                            .foregroundStyle(VColor.contentInset)
                    }
                    .padding(VSpacing.sm)
                }
            }
        }
        .buttonStyle(.plain)
        .pointerCursor(onHover: { hovering in
            withAnimation(VAnimation.fast) {
                hoveredTool = hovering ? item.id : nil
            }
        })
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

// MARK: - Wrapping horizontal layout

private struct WrappingHStack: Layout {
    var hSpacing: CGFloat
    var vSpacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = computeRows(proposal: proposal, subviews: subviews)
        guard !rows.isEmpty else { return .zero }
        let height = rows.enumerated().reduce(CGFloat.zero) { acc, pair in
            let rowHeight = pair.element.map { $0.size.height }.max() ?? 0
            return acc + rowHeight + (pair.offset > 0 ? vSpacing : 0)
        }
        return CGSize(width: proposal.width ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = computeRows(proposal: proposal, subviews: subviews)
        var y = bounds.minY
        for row in rows {
            let rowHeight = row.map { $0.size.height }.max() ?? 0
            var x = bounds.minX
            for item in row {
                item.subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(item.size))
                x += item.size.width + hSpacing
            }
            y += rowHeight + vSpacing
        }
    }

    private struct LayoutItem {
        let subview: LayoutSubview
        let size: CGSize
    }

    private func computeRows(proposal: ProposedViewSize, subviews: Subviews) -> [[LayoutItem]] {
        let maxWidth = proposal.width ?? .infinity
        var rows: [[LayoutItem]] = [[]]
        var currentRowWidth: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            let needed = currentRowWidth > 0 ? size.width + hSpacing : size.width
            if currentRowWidth + needed > maxWidth, !rows[rows.count - 1].isEmpty {
                rows.append([])
                currentRowWidth = 0
            }
            rows[rows.count - 1].append(LayoutItem(subview: subview, size: size))
            currentRowWidth += currentRowWidth > 0 ? size.width + hSpacing : size.width
        }
        return rows
    }
}
