import VellumAssistantShared
#if DEBUG
import SwiftUI

enum GalleryCategory: String, CaseIterable, Identifiable {
    case buttons = "Buttons"
    case display = "Display"
    case feedback = "Feedback"
    case inputs = "Inputs"
    case layout = "Layout"
    case navigation = "Navigation"
    case modifiers = "Modifiers"
    case tokens = "Tokens"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .buttons: return "hand.tap"
        case .display: return "rectangle.on.rectangle"
        case .feedback: return "bell"
        case .inputs: return "character.cursor.ibeam"
        case .layout: return "rectangle.split.3x1"
        case .navigation: return "arrow.triangle.branch"
        case .modifiers: return "paintbrush"
        case .tokens: return "paintpalette"
        }
    }
}

struct ComponentGalleryView: View {
    @State private var selectedCategory: GalleryCategory? = .buttons

    var body: some View {
        NavigationSplitView {
            List(selection: $selectedCategory) {
                ForEach(GalleryCategory.allCases) { category in
                    Label(category.rawValue, systemImage: category.icon)
                        .tag(category)
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 240)
        } detail: {
            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.xxl) {
                    if let category = selectedCategory {
                        switch category {
                        case .buttons: ButtonsGallerySection()
                        case .display: DisplayGallerySection()
                        case .feedback: FeedbackGallerySection()
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
                            icon: "sidebar.left"
                        )
                    }
                }
                .padding(VSpacing.xxl)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(VColor.background)
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
                .foregroundColor(VColor.textPrimary)
            Text(description)
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
        }
    }
}

#Preview("Component Gallery") {
    ComponentGalleryView()
        .frame(width: 900, height: 700)
}
#endif
