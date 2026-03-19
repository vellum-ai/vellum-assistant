#if DEBUG
import SwiftUI

// MARK: - Data Model

enum ComponentGalleryCategory: String, CaseIterable, Identifiable {
    case appIcons = "App Icons"
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
        case .appIcons: return .layoutGrid
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
        case .appIcons:
            return []
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
            return []
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
    @State private var expandedCategories: Set<ComponentGalleryCategory> = []

    private var isSearching: Bool {
        !searchText.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func isExpanded(_ category: ComponentGalleryCategory) -> Binding<Bool> {
        Binding(
            get: { isSearching || expandedCategories.contains(category) },
            set: { newValue in
                if newValue {
                    expandedCategories.insert(category)
                } else {
                    expandedCategories.remove(category)
                }
            }
        )
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
                VSearchBar(placeholder: "Filter components...", text: $searchText)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)

                List(selection: $selectedPage) {
                    ForEach(filteredCategories, id: \.category) { item in
                        if item.components.isEmpty {
                            Label { Text(item.category.rawValue) } icon: { VIconView(item.category.vIcon, size: 14) }
                                .tag(GalleryPage.overview(item.category))
                        } else {
                            DisclosureGroup(isExpanded: isExpanded(item.category)) {
                                Text("Overview")
                                    .tag(GalleryPage.overview(item.category))
                                ForEach(item.components, id: \.id) { component in
                                    Text(component.title)
                                        .tag(GalleryPage.component(item.category, component.id))
                                }
                            } label: {
                                Label { Text(item.category.rawValue) } icon: { VIconView(item.category.vIcon, size: 14) }
                            }
                        }
                    }
                }
                .listStyle(.sidebar)

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
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(VColor.surfaceOverlay)
        }
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
        case .appIcons: AppIconGallerySection()
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
        case .appIcons: AppIconGallerySection()
        case .buttons: ButtonsGallerySection.componentPage(componentID)
        case .chat: ChatGallerySection.componentPage(componentID)
        case .display: DisplayGallerySection.componentPage(componentID)
        case .feedback: FeedbackGallerySection.componentPage(componentID)
        case .icons: IconsGallerySection()
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
