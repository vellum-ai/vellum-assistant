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
        VStack(spacing: 0) {
            // Header bar (similar to main app top bar)
            galleryHeaderBar

            // Sidebar + detail content
            HStack(spacing: 0) {
                gallerySidebar
                detailContent
            }
        }
        .background(VColor.surfaceBase)
    }

    // MARK: - Header Bar

    private var galleryHeaderBar: some View {
        HStack(spacing: VSpacing.sm) {
            Text("Component Gallery")
                .font(VFont.headline)
                .foregroundColor(VColor.contentDefault)

            Spacer()

            VThemeToggle()
        }
        .padding(.horizontal, VSpacing.lg)
        .frame(height: 48)
        .background(VColor.surfaceOverlay)
    }

    // MARK: - Sidebar

    private var gallerySidebar: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: VSpacing.xs) {
                    ForEach(ComponentGalleryCategory.allCases) { category in
                        GallerySidebarRow(
                            icon: category.vIcon,
                            label: category.rawValue,
                            isActive: selectedCategory == category
                        ) {
                            selectedCategory = category
                        }
                    }
                }
                .padding(.vertical, VSpacing.md)
                .padding(.horizontal, VSpacing.md)
            }
        }
        .frame(width: 200)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .padding(VSpacing.md)
    }

    // MARK: - Detail Content

    private var detailContent: some View {
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
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .padding(.vertical, VSpacing.md)
        .padding(.trailing, VSpacing.md)
    }
}

// MARK: - Sidebar Row

private struct GallerySidebarRow: View {
    let icon: VIcon
    let label: String
    var isActive: Bool = false
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(icon, size: 13)
                .foregroundColor(isActive ? VColor.primaryActive : VColor.primaryBase)
                .frame(width: 20, height: 20)
            Text(label)
                .font(VFont.body)
                .foregroundColor(isActive ? VColor.contentEmphasized : VColor.contentSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer()
        }
        .padding(.leading, VSpacing.xs)
        .padding(.trailing, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .frame(minHeight: 32)
        .background(
            isActive ? VColor.surfaceActive :
            isHovered ? VColor.surfaceBase :
            Color.clear
        )
        .animation(VAnimation.fast, value: isHovered)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .contentShape(Rectangle())
        .onTapGesture { action() }
        .onHover { isHovered = $0 }
        .pointerCursor()
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
