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

    var components: [(id: String, title: String, keywords: [String])] {
        switch self {
        case .buttons:
            return [
                ("vButton", "VButton", ["button"]),
                ("vSplitButton", "VSplitButton", ["split button", "dropdown button"]),
            ]
        case .chat:
            return [
                ("voiceComposer", "VStreamingWaveform", ["voice composer", "waveform", "dictation"]),
                ("skillInvocation", "SkillInvocationChip", ["skill invocation", "skill chip"]),
                ("subagentStatus", "SubagentStatusChip", ["subagent status", "subagent conversation"]),
                ("toolChips", "ToolCallChip", ["tool chips", "tool call"]),
                ("stepIndicators", "CurrentStepIndicator", ["step indicators", "progress bar", "tool call progress"]),
                ("progressIndicators", "TypingIndicatorView", ["progress indicators", "typing", "running"]),
                ("toolConfirmations", "ToolConfirmationBubble", ["tool confirmations", "permission", "approval"]),
            ]
        case .display:
            return [
                ("vCard", "VCard", ["card"]),
                ("vEmptyState", "VEmptyState", ["empty state"]),
                ("vDisclosureSection", "VDisclosureSection", ["disclosure", "collapsible"]),
                ("vListRow", "VListRow", ["list row"]),
                ("vAvatarImage", "VAvatarImage", ["avatar", "image"]),
                ("vCodeView", "VCodeView", ["code view", "syntax"]),
                ("vDiffView", "VDiffView", ["diff view"]),
                ("vStreamingWaveform", "VStreamingWaveform", ["waveform", "streaming"]),
            ]
        case .feedback:
            return [
                ("vBadge", "VBadge", ["badge"]),
                ("vLoadingIndicator", "VLoadingIndicator", ["loading", "spinner"]),
                ("vToast", "VToast", ["toast", "notification"]),
                ("vInlineMessage", "VInlineMessage", ["inline message", "alert"]),
                ("vShortcutTag", "VShortcutTag", ["shortcut", "keyboard"]),
                ("vCopyButton", "VCopyButton", ["copy", "clipboard"]),
                ("vBusyIndicator", "VBusyIndicator", ["busy", "activity"]),
                ("vSkeletonBone", "VSkeletonBone", ["skeleton", "placeholder"]),
                ("vSkillTypePill", "VSkillTypePill", ["skill type", "pill"]),
                ("vInfoTooltip", "VInfoTooltip", ["info", "tooltip"]),
            ]
        case .icons:
            return [
                ("vAppIconGenerator", "VAppIconGenerator", ["app icon", "generator"]),
                ("iconTokens", "VIcon", ["icon tokens", "icon catalog"]),
            ]
        case .inputs:
            return [
                ("vTextField", "VTextField", ["text field", "input"]),
                ("vSlider", "VSlider", ["slider", "range"]),
                ("vTextEditor", "VTextEditor", ["text editor", "multiline"]),
                ("vToggle", "VToggle", ["toggle", "switch"]),
                ("vDropdown", "VDropdown", ["dropdown", "select", "picker"]),
            ]
        case .layout:
            return [
                ("vModal", "VModal", ["modal", "dialog"]),
                ("vAdaptiveStack", "VAdaptiveStack", ["adaptive stack", "responsive"]),
                ("vSidePanel", "VSidePanel", ["side panel", "drawer"]),
                ("vSplitView", "VSplitView", ["split view", "resizable"]),
            ]
        case .modifiers:
            return [
                ("vCardMod", ".vCard()", ["card modifier"]),
                ("pointerCursor", ".pointerCursor()", ["pointer", "cursor", "hand"]),
                ("nativeTooltip", ".nativeTooltip()", ["native tooltip", "help"]),
                ("vTooltip", ".vTooltip()", ["tooltip", "popover"]),
                ("vPanelBackground", ".vPanelBackground()", ["panel background"]),
                ("ifMod", ".if()", ["conditional modifier"]),
                ("vShimmer", ".vShimmer()", ["shimmer", "loading animation"]),
                ("inlineWidgetCard", ".inlineWidgetCard()", ["inline widget", "card"]),
            ]
        case .navigation:
            return [
                ("vSegmentedControl", "VSegmentedControl", ["segmented control", "tabs"]),
                ("vSidebarRow", "VSidebarRow", ["sidebar row", "navigation row"]),
                ("vTabBar", "VTabBar + VTab", ["tab bar", "tabs"]),
                ("vThemeToggle", "VThemeToggle", ["theme toggle", "dark mode", "light mode"]),
            ]
        case .tokens:
            return [
                ("colors", "VColor", ["colors", "semantic colors", "theme"]),
                ("typography", "VFont", ["typography", "fonts", "text styles"]),
                ("spacing", "VSpacing", ["spacing", "padding", "margins"]),
                ("radius", "VRadius", ["radius", "corner radius", "rounded"]),
                ("shadows", "VShadow", ["shadows", "elevation"]),
                ("animations", "VAnimation", ["animations", "transitions", "motion"]),
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

    private var isSearching: Bool {
        !searchText.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private var allExpanded: Bool {
        let expandable = ComponentGalleryCategory.allCases.filter { !$0.components.isEmpty }
        return expandable.allSatisfy { expandedCategories.contains($0) }
    }

    private var filteredCategories: [(category: ComponentGalleryCategory, components: [(id: String, title: String, keywords: [String])])] {
        let query = searchText.lowercased().trimmingCharacters(in: .whitespaces)
        if query.isEmpty {
            return ComponentGalleryCategory.allCases.map { ($0, $0.components) }
        }
        return ComponentGalleryCategory.allCases.compactMap { category in
            let matchingComponents = category.components.filter { component in
                component.title.lowercased().contains(query)
                    || component.id.lowercased().contains(query)
                    || component.keywords.contains { $0.lowercased().contains(query) }
            }
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
                    VStack(spacing: VSpacing.xs) {
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
    private func sidebarCategory(_ category: ComponentGalleryCategory, components: [(id: String, title: String, keywords: [String])]) -> some View {
        let isCategoryExpanded = isSearching || expandedCategories.contains(category)

        VStack(spacing: 0) {
            VSidebarRow(
                icon: category.vIcon.rawValue,
                label: category.rawValue,
                trailingIcon: VIcon.chevronRight.rawValue,
                trailingIconRotation: .degrees(isCategoryExpanded ? 90 : 0)
            ) {
                guard !isSearching else { return }
                withAnimation(VAnimation.fast) {
                    if expandedCategories.contains(category) {
                        expandedCategories.remove(category)
                    } else {
                        expandedCategories.insert(category)
                    }
                }
            }
            .accessibilityValue(isCategoryExpanded ? "expanded" : "collapsed")
            .accessibilityHint("Double-tap to \(isCategoryExpanded ? "collapse" : "expand")")

            if isCategoryExpanded {
                VStack(spacing: VSpacing.xs) {
                    sidebarRow(label: "Overview", page: .overview(category))
                    ForEach(components, id: \.id) { component in
                        sidebarRow(
                            label: component.title,
                            page: .component(category, component.id)
                        )
                    }
                }
                .padding(.leading, VSpacing.md)
            }
        }
    }

    private func sidebarRow(label: String, page: GalleryPage) -> some View {
        let isSelected = selectedPage == page

        return VSidebarRow(
            label: label,
            isActive: isSelected
        ) {
            selectedPage = page
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
