#if DEBUG
import SwiftUI

enum ComponentGalleryCategory: String, CaseIterable, Identifiable {
    case appIcons = "App Icons"
    case buttons = "Buttons"
    case chat = "Chat"
    case display = "Display"
    case feedback = "Feedback"
    case icons = "Icons"
    case inputs = "Inputs"
    case layout = "Layout"
    case navigation = "Navigation"
    case modifiers = "Modifiers"
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
        case .navigation: return .gitBranch
        case .modifiers: return .paintbrush
        case .tokens: return .paintbrush
        }
    }
}

struct ComponentGalleryView: View {
    @State private var selectedCategory: ComponentGalleryCategory? = .buttons

    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                List(selection: $selectedCategory) {
                    ForEach(ComponentGalleryCategory.allCases) { category in
                        Label { Text(category.rawValue) } icon: { VIconView(category.vIcon, size: 14) }
                            .tag(category)
                    }
                }
                .listStyle(.sidebar)

                Divider()

                VThemeToggle()
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.sm)
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 240)
        } detail: {
            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.xxl) {
                    if let category = selectedCategory {
                        switch category {
                        case .appIcons: AppIconGallerySection()
                        case .buttons: ButtonsGallerySection()
                        case .chat: ChatGallerySection()
                        case .display: DisplayGallerySection()
                        case .feedback: FeedbackGallerySection()
                        case .icons: IconsGallerySection()
                        case .inputs: InputsGallerySection()
                        case .layout: LayoutGallerySection()
                        case .navigation: NavigationGallerySection()
                        case .modifiers: ModifiersGallerySection()
                        case .tokens: TokensGallerySection()
                        }
                    } else {
                        VEmptyState(
                            title: "Select a category",
                            subtitle: "Choose a component category from the sidebar",
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
}

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
