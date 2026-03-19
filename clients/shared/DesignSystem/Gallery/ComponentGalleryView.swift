#if DEBUG
import SwiftUI

// MARK: - Data Model

enum ComponentGalleryCategory: String, CaseIterable, Identifiable {
    case buttons = "Buttons"
    case chat = "Chat"
    case display = "Display"
    case feedback = "Feedback"
    case icons = "Icons"
    case inputs = "Inputs"
    case layout = "Layout"
    case modifiers = "Modifiers"
    case navigation = "Navigation"
    case tokens = "Tokens"

    var id: String { rawValue }

    var vIcon: VIcon {
        switch self {
        case .buttons: return .mousePointerClick
        case .chat: return .messagesSquare
        case .display: return .layers
        case .feedback: return .bell
        case .icons: return .puzzle
        case .inputs: return .pencil
        case .layout: return .panelLeft
        case .modifiers: return .paintbrush
        case .navigation: return .gitBranch
        case .tokens: return .paintbrush
        }
    }

    var components: [(id: String, title: String)] {
        switch self {
        case .buttons:
            return [
                ("vButton", "VButton"),
                ("vSplitButton", "VSplitButton"),
            ]
        case .chat:
            return [
                ("voiceComposer", "Voice Composer"),
                ("skillInvocation", "Skill Invocation"),
                ("subagentStatus", "Subagent Status"),
                ("toolChips", "Tool Chips"),
                ("stepIndicators", "Step Indicators"),
                ("progressIndicators", "Progress Indicators"),
                ("toolConfirmations", "Tool Confirmations"),
            ]
        case .display:
            return [
                ("vCard", "VCard"),
                ("vEmptyState", "VEmptyState"),
                ("vDisclosureSection", "VDisclosureSection"),
                ("vListRow", "VListRow"),
                ("vAvatarImage", "VAvatarImage"),
                ("vCodeView", "VCodeView"),
                ("vDiffView", "VDiffView"),
                ("vStreamingWaveform", "VStreamingWaveform"),
            ]
        case .feedback:
            return [
                ("vBadge", "VBadge"),
                ("vLoadingIndicator", "VLoadingIndicator"),
                ("vToast", "VToast"),
                ("vInlineMessage", "VInlineMessage"),
                ("vShortcutTag", "VShortcutTag"),
                ("vCopyButton", "VCopyButton"),
                ("vBusyIndicator", "VBusyIndicator"),
                ("vSkeletonBone", "VSkeletonBone"),
                ("vSkillTypePill", "VSkillTypePill"),
                ("vInfoTooltip", "VInfoTooltip"),
            ]
        case .icons:
            return [
                ("vAppIconGenerator", "VAppIconGenerator"),
                ("iconTokens", "Icon Tokens"),
            ]
        case .inputs:
            return [
                ("vTextField", "VTextField"),
                ("vSlider", "VSlider"),
                ("vTextEditor", "VTextEditor"),
                ("vToggle", "VToggle"),
                ("vDropdown", "VDropdown"),
            ]
        case .layout:
            return [
                ("vModal", "VModal"),
                ("vAdaptiveStack", "VAdaptiveStack"),
                ("vSidePanel", "VSidePanel"),
                ("vSplitView", "VSplitView"),
            ]
        case .modifiers:
            return [
                ("vCardMod", ".vCard()"),
                ("pointerCursor", ".pointerCursor()"),
                ("nativeTooltip", ".nativeTooltip()"),
                ("vTooltip", ".vTooltip()"),
                ("vPanelBackground", ".vPanelBackground()"),
                ("ifMod", ".if()"),
                ("vShimmer", ".vShimmer()"),
                ("inlineWidgetCard", ".inlineWidgetCard()"),
            ]
        case .navigation:
            return [
                ("vSegmentedControl", "VSegmentedControl"),
                ("vTabBar", "VTabBar + VTab"),
                ("vThemeToggle", "VThemeToggle"),
            ]
        case .tokens:
            return [
                ("colors", "Colors"),
                ("typography", "Typography"),
                ("spacing", "Spacing"),
                ("radius", "Radius"),
                ("shadows", "Shadows"),
                ("animations", "Animations"),
            ]
        }
    }
}

enum GalleryPage: Hashable {
    case overview(ComponentGalleryCategory)
    case component(ComponentGalleryCategory, String)
}

// MARK: - Gallery View

struct ComponentGalleryView: View {
    @State private var selectedPage: GalleryPage? = .overview(.buttons)
    @State private var searchText: String = ""
    @State private var expandedCategories: Set<ComponentGalleryCategory> = [.buttons]
    @State private var hoveredPage: GalleryPage?

    private var isSearching: Bool {
        !searchText.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private var allExpanded: Bool {
        let expandable = ComponentGalleryCategory.allCases.filter { !$0.components.isEmpty }
        return expandable.allSatisfy { expandedCategories.contains($0) }
    }

    private func isCategoryExpanded(_ category: ComponentGalleryCategory) -> Bool {
        isSearching || expandedCategories.contains(category)
    }

    private func toggleCategory(_ category: ComponentGalleryCategory) {
        guard !isSearching else { return }
        withAnimation(VAnimation.fast) {
            if expandedCategories.contains(category) {
                expandedCategories.remove(category)
            } else {
                expandedCategories.insert(category)
            }
        }
    }

    private var filteredCategories: [(category: ComponentGalleryCategory, components: [(id: String, title: String)])] {
        let query = searchText.lowercased().trimmingCharacters(in: .whitespaces)
        if query.isEmpty {
            return ComponentGalleryCategory.allCases.map { ($0, $0.components) }
        }
        return ComponentGalleryCategory.allCases.compactMap { category in
            let matchingComponents = category.components.filter { $0.title.lowercased().contains(query) }
            let categoryMatches = category.rawValue.lowercased().contains(query)
            if categoryMatches {
                return (category, category.components)
            } else if !matchingComponents.isEmpty {
                return (category, matchingComponents)
            }
            return nil
        }
    }

    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                HStack {
                    VSearchBar(placeholder: "Filter components...", text: $searchText)

                    Button(action: {
                        withAnimation(VAnimation.fast) {
                            let expandable = Set(ComponentGalleryCategory.allCases.filter { !$0.components.isEmpty })
                            if allExpanded {
                                expandedCategories.subtract(expandable)
                            } else {
                                expandedCategories.formUnion(expandable)
                            }
                        }
                    }) {
                        VIconView(allExpanded ? .chevronsDownUp : .chevronsUpDown, size: 14)
                            .foregroundColor(VColor.contentTertiary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(allExpanded ? "Collapse all" : "Expand all")
                }
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xs)

                ScrollView {
                    VStack(spacing: VSpacing.xxs) {
                        ForEach(filteredCategories, id: \.category) { item in
                            sidebarCategory(item.category, components: item.components)
                        }
                    }
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)
                }

                Divider()

                VThemeToggle()
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.sm)
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 260)
        } detail: {
            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.xxl) {
                    if let page = selectedPage {
                        galleryContent(for: page)
                    } else {
                        VEmptyState(
                            title: "Select a component",
                            subtitle: "Choose a component from the sidebar",
                            icon: VIcon.panelLeft.rawValue
                        )
                    }
                }
                .padding(VSpacing.xxl)
            }
            .id(selectedPage)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(VColor.surfaceOverlay)
        }
    }

    // MARK: - Sidebar Components

    @ViewBuilder
    private func sidebarCategory(_ category: ComponentGalleryCategory, components: [(id: String, title: String)]) -> some View {
        VStack(spacing: 0) {
            // Category header
            Button {
                toggleCategory(category)
            } label: {
                HStack(spacing: VSpacing.xs) {
                    VIconView(category.vIcon, size: 14)
                        .foregroundColor(VColor.contentTertiary)
                        .frame(width: 20)
                    Text(category.rawValue)
                        .font(VFont.bodyBold)
                        .foregroundColor(VColor.contentDefault)
                        .lineLimit(1)
                    Spacer()
                    if !components.isEmpty {
                        VIconView(.chevronRight, size: 10)
                            .foregroundColor(VColor.contentTertiary)
                            .rotationEffect(.degrees(isCategoryExpanded(category) ? 90 : 0))
                            .animation(VAnimation.fast, value: isCategoryExpanded(category))
                    }
                }
                .padding(.vertical, VSpacing.xs)
                .padding(.horizontal, VSpacing.xs)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .accessibilityLabel(category.rawValue)
            .accessibilityValue(isCategoryExpanded(category) ? "expanded" : "collapsed")
            .accessibilityHint(components.isEmpty ? "" : "Double-tap to \(isCategoryExpanded(category) ? "collapse" : "expand")")

            // Expanded children
            if isCategoryExpanded(category) && !components.isEmpty {
                VStack(spacing: 0) {
                    sidebarRow(
                        label: "Overview",
                        page: .overview(category),
                        indented: true
                    )
                    ForEach(components, id: \.id) { component in
                        sidebarRow(
                            label: component.title,
                            page: .component(category, component.id),
                            indented: true
                        )
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private func sidebarRow(label: String, page: GalleryPage, indented: Bool = false) -> some View {
        let isSelected = selectedPage == page
        let isHovered = hoveredPage == page

        return Button {
            selectedPage = page
        } label: {
            Text(label)
                .font(VFont.body)
                .foregroundColor(isSelected ? VColor.contentEmphasized : VColor.contentDefault)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, VSpacing.xs)
                .padding(.leading, indented ? VSpacing.xl : VSpacing.xs)
                .padding(.trailing, VSpacing.xs)
                .background(
                    isSelected ? VColor.surfaceActive :
                    isHovered ? VColor.surfaceBase :
                    Color.clear
                )
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .onHover { hovering in
            hoveredPage = hovering ? page : nil
        }
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private func galleryContent(for page: GalleryPage) -> some View {
        switch page {
        case .overview(let category):
            overviewContent(for: category)
        case .component(let category, let componentID):
            componentContent(for: category, componentID: componentID)
        }
    }

    @ViewBuilder
    private func overviewContent(for category: ComponentGalleryCategory) -> some View {
        switch category {
        case .buttons: ButtonsGallerySection()
        case .chat: ChatGallerySection()
        case .display: DisplayGallerySection()
        case .feedback: FeedbackGallerySection()
        case .icons: IconsGallerySection()
        case .inputs: InputsGallerySection()
        case .layout: LayoutGallerySection()
        case .modifiers: ModifiersGallerySection()
        case .navigation: NavigationGallerySection()
        case .tokens: TokensGallerySection()
        }
    }

    @ViewBuilder
    private func componentContent(for category: ComponentGalleryCategory, componentID: String) -> some View {
        switch category {
        case .buttons: ButtonsGallerySection.componentPage(componentID)
        case .chat: ChatGallerySection.componentPage(componentID)
        case .display: DisplayGallerySection.componentPage(componentID)
        case .feedback: FeedbackGallerySection.componentPage(componentID)
        case .icons: IconsGallerySection.componentPage(componentID)
        case .inputs: InputsGallerySection.componentPage(componentID)
        case .layout: LayoutGallerySection.componentPage(componentID)
        case .modifiers: ModifiersGallerySection.componentPage(componentID)
        case .navigation: NavigationGallerySection.componentPage(componentID)
        case .tokens: TokensGallerySection.componentPage(componentID)
        }
    }
}

// MARK: - Section Header

struct GallerySectionHeader: View {
    let title: String
    let description: String

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text(title)
                .font(VFont.largeTitle)
                .foregroundColor(VColor.contentDefault)
            Text(description)
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
        }
    }
}

#endif
