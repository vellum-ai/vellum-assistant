import SwiftUI
import VellumAssistantShared

@MainActor
struct NameExchangeView: View {
    // MARK: - Configuration

    @Binding var userName: String
    @Binding var assistantName: String
    @Binding var selectedGroupID: String?

    /// Names to display as quick-tap pills, ordered by the caller based on
    /// the currently selected personality group.
    let displayedAssistantNames: [String]

    var onBack: (() -> Void)?
    var onComplete: () -> Void
    var onSkip: () -> Void

    // MARK: - Private State

    @State private var showHeader = false
    @State private var showContent = false
    @State private var hoveredSuggestion: String?
    @State private var hoveredGroup: String?

    /// Usernames that are clearly not real names and should not be pre-filled.
    private static let usernameBlacklist: Set<String> = ["admin", "user", "root", "guest"]

    // MARK: - Body

    var body: some View {
        VStack(spacing: 0) {
            // Header
            ZStack(alignment: .leading) {
                Text("Let's get to know each other.")
                    .font(VFont.titleLarge)
                    .foregroundStyle(VColor.contentDefault)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, VSpacing.xxl)

                if let onBack {
                    Button {
                        onBack()
                    } label: {
                        VIconView(.chevronLeft, size: 16)
                            .foregroundStyle(VColor.contentSecondary)
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()
                    .accessibilityLabel("Back")
                    .padding(.leading, VSpacing.xxl)
                }
            }
            .opacity(showHeader ? 1 : 0)
            .offset(y: showHeader ? 0 : 8)
            .padding(.bottom, VSpacing.sm)

            Text("You can change these any time.")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .opacity(showHeader ? 1 : 0)
                .offset(y: showHeader ? 0 : 8)
                .padding(.horizontal, VSpacing.xxl)
                .padding(.bottom, VSpacing.xl)

            // Form content
            VStack(spacing: VSpacing.lg) {
                VTextField(
                    "Your name",
                    placeholder: "Your name",
                    text: $userName
                )

                // Personality group grid
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Pick a vibe")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)

                    LazyVGrid(columns: [GridItem(.flexible(), spacing: VSpacing.sm), GridItem(.flexible(), spacing: VSpacing.sm)], spacing: VSpacing.sm) {
                        ForEach(PersonalityGroup.allGroups, id: \.id) { group in
                            vibeCard(group)
                        }
                    }
                }

                // Assistant name + suggestions
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    VTextField(
                        "What should I go by?",
                        placeholder: "Assistant name",
                        text: $assistantName
                    )

                    Text(selectedGroupID != nil ? "Suggestions" : "A few to try")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .textCase(.uppercase)

                    WrappingHStack(hSpacing: VSpacing.xs, vSpacing: VSpacing.xs) {
                        ForEach(displayedAssistantNames, id: \.self) { suggestion in
                            suggestionPill(suggestion)
                        }
                    }
                }

            }
            .padding(.horizontal, VSpacing.xxl)
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 12)

            Spacer()

            // Footer: primary action + skip
            VStack(spacing: VSpacing.sm) {
                VButton(label: "Let's go", style: .primary, isFullWidth: true) {
                    onComplete()
                }

                VButton(label: "Skip", style: .ghost, tintColor: VColor.contentTertiary) {
                    onSkip()
                }
            }
            .padding(.horizontal, VSpacing.xxl)
            .padding(.bottom, VSpacing.xxl)
            .opacity(showContent ? 1 : 0)
        }
        .onAppear {
            withAnimation(VAnimation.slow.delay(0.1)) {
                showHeader = true
            }
            withAnimation(VAnimation.slow.delay(0.3)) {
                showContent = true
            }
        }
    }

    // MARK: - Subviews

    private static let vibeTaglines: [String: String] = [
        "grounded": "Measured. No filler.",
        "warm": "Friendly and casual.",
        "energetic": "Brief. To the point.",
        "poetic": "Listens, then replies.",
    ]

    private func vibeCard(_ group: PersonalityGroup) -> some View {
        let isActive = selectedGroupID == group.id
        let isHovered = hoveredGroup == group.id
        return Button {
            withAnimation(VAnimation.fast) {
                if isActive {
                    selectedGroupID = nil
                    assistantName = ""
                } else {
                    selectedGroupID = group.id
                    assistantName = group.names.first ?? ""
                }
            }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(group.descriptor)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(isActive ? VColor.contentInset : VColor.contentDefault)
                Text(Self.vibeTaglines[group.id] ?? "")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(isActive ? VColor.contentInset.opacity(0.62) : VColor.contentSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(EdgeInsets(top: VSpacing.md, leading: VSpacing.md, bottom: VSpacing.md, trailing: VSpacing.md))
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(isActive ? VColor.primaryBase : (isHovered ? VColor.surfaceBase : VColor.surfaceLift))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(isActive ? VColor.primaryBase : VColor.borderElement, lineWidth: 0.5)
                    )
            )
        }
        .buttonStyle(.plain)
        .pointerCursor(onHover: { hovering in
            withAnimation(VAnimation.fast) {
                hoveredGroup = hovering ? group.id : nil
            }
        })
        .accessibilityLabel("\(group.label), \(group.descriptor)")
        .accessibilityValue(isActive ? "Selected" : "Not selected")
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    private func suggestionPill(_ name: String) -> some View {
        let isActive = assistantName == name
        return Button {
            assistantName = name
            withAnimation(VAnimation.fast) {
                selectedGroupID = PersonalityGroup.groupForName(name)?.id
            }
        } label: {
            Text(name)
                .font(VFont.menuCompact)
                .foregroundStyle(isActive ? VColor.contentInset : VColor.contentDefault)
                .padding(EdgeInsets(top: VSpacing.xs + 1, leading: VSpacing.md, bottom: VSpacing.xs + 1, trailing: VSpacing.md))
                .background(
                    RoundedRectangle(cornerRadius: VRadius.pill)
                        .fill(isActive ? VColor.primaryBase : (hoveredSuggestion == name ? VColor.surfaceBase : VColor.surfaceLift))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.pill)
                                .stroke(isActive ? VColor.primaryBase : VColor.borderElement, lineWidth: 1)
                        )
                )
        }
        .buttonStyle(.plain)
        .pointerCursor(onHover: { hovering in
            withAnimation(VAnimation.fast) {
                hoveredSuggestion = hovering ? name : nil
            }
        })
        .accessibilityLabel(name)
        .accessibilityValue(isActive ? "Selected" : "Not selected")
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    // MARK: - Helpers

    /// Determines a suitable pre-fill value for the user name field based on
    /// macOS system user information.
    ///
    /// Returns the full name if it contains a space (indicating a real first+last
    /// name), or the short username if it is longer than 2 characters and does
    /// not match the blacklist. Otherwise returns an empty string.
    static func defaultUserName() -> String {
        let fullName = NSFullUserName()
        if fullName.contains(" ") {
            return fullName
        }

        let shortName = NSUserName()
        let lower = shortName.lowercased()

        // Reject blacklisted names
        if usernameBlacklist.contains(lower) {
            return ""
        }

        // Reject all-numeric usernames
        if shortName.allSatisfy(\.isNumber) {
            return ""
        }

        // Accept if longer than 2 characters
        if shortName.count > 2 {
            return shortName
        }

        return ""
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
