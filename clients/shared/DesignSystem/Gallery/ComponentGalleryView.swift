#if DEBUG
import SwiftUI

// MARK: - Data Model

struct GalleryComponent: Identifiable {
    let id: String
    let title: String
    let keywords: [String]
    let description: String
    let useInsteadOf: String?

    init(_ id: String, _ title: String, keywords: [String], description: String, useInsteadOf: String? = nil) {
        self.id = id
        self.title = title
        self.keywords = keywords
        self.description = description
        self.useInsteadOf = useInsteadOf
    }
}

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

    var components: [GalleryComponent] {
        switch self {
        case .buttons:
            return [
                GalleryComponent("vButton", "VButton", keywords: ["button"], description: "Primary action button with multiple styles (primary, outlined, danger, ghost, contrast), icon support, full-width option, and inline size.", useInsteadOf: "Custom Button with manual styling"),
                GalleryComponent("vSplitButton", "VSplitButton", keywords: ["split button", "dropdown button"], description: "Split button with a primary action and dropdown menu for secondary actions."),
            ]
        case .chat:
            return [
                GalleryComponent("voiceComposer", "VStreamingWaveform", keywords: ["voice composer", "waveform", "dictation"], description: "Animated waveform for voice dictation and conversation audio feedback."),
                GalleryComponent("skillInvocation", "SkillInvocationChip", keywords: ["skill invocation", "skill chip"], description: "Compact pill showing a skill being invoked with its name and status."),
                GalleryComponent("subagentStatus", "SubagentStatusChip", keywords: ["subagent status", "subagent conversation"], description: "Status chip for subagent conversations showing name and activity state."),
                GalleryComponent("toolChips", "ToolCallChip", keywords: ["tool chips", "tool call"], description: "Compact chip showing a tool call with name, status icon, and optional duration."),
                GalleryComponent("stepIndicators", "CurrentStepIndicator", keywords: ["step indicators", "progress bar", "tool call progress"], description: "Progress bar showing the current step in a multi-step tool call."),
                GalleryComponent("progressIndicators", "TypingIndicatorView", keywords: ["progress indicators", "typing", "running"], description: "Animated dots indicating the assistant is typing or processing."),
                GalleryComponent("toolConfirmations", "ToolConfirmationBubble", keywords: ["tool confirmations", "permission", "approval"], description: "Approval bubble for tool calls that require user permission before execution."),
            ]
        case .display:
            return [
                GalleryComponent("vCard", "VCard", keywords: ["card"], description: "Container with surface background, border, and configurable padding. Use .vCard() modifier for simple wrapping.", useInsteadOf: "Manual padding + background + cornerRadius"),
                GalleryComponent("vEmptyState", "VEmptyState", keywords: ["empty state"], description: "Centered placeholder with icon, title, subtitle, and optional action button for empty content areas."),
                GalleryComponent("vDisclosureSection", "VDisclosureSection", keywords: ["disclosure", "collapsible"], description: "Full-row clickable disclosure with animated chevron. Replaces DisclosureGroup.", useInsteadOf: "Raw DisclosureGroup"),
                GalleryComponent("vListRow", "VListRow", keywords: ["list row"], description: "List item with hover highlight and optional tap action."),
                GalleryComponent("vAvatarImage", "VAvatarImage", keywords: ["avatar", "image"], description: "Avatar with transparency-aware clip shape. Transparent images show full artwork; opaque images clip to a circle."),
                GalleryComponent("vCodeView", "VCodeView", keywords: ["code view", "syntax"], description: "Read-only code viewer with line numbers, search, and pluggable syntax highlighting. Wraps NSTextView for native text selection."),
                GalleryComponent("vDiffView", "VDiffView", keywords: ["diff view"], description: "Renders unified diff text with per-line colored backgrounds. Green for additions, red for removals."),
                GalleryComponent("vStreamingWaveform", "VStreamingWaveform", keywords: ["waveform", "streaming"], description: "Animated audio waveform driven by amplitude. Two styles: conversation (centered) and dictation (bottom-aligned)."),
            ]
        case .feedback:
            return [
                GalleryComponent("vBadge", "VBadge", keywords: ["badge"], description: "Notification count badge with semantic color variants."),
                GalleryComponent("vLoadingIndicator", "VLoadingIndicator", keywords: ["loading", "spinner"], description: "Spinning indicator for inline loading states. Use VSkeletonBone for structured loading layouts."),
                GalleryComponent("vToast", "VToast", keywords: ["toast", "notification"], description: "Temporary notification banner with auto-dismiss and action support."),
                GalleryComponent("vInlineMessage", "VInlineMessage", keywords: ["inline message", "alert"], description: "Persistent inline alert with icon and semantic color (info, warning, error, success)."),
                GalleryComponent("vShortcutTag", "VShortcutTag", keywords: ["shortcut", "keyboard"], description: "Keyboard shortcut display tag showing key combinations."),
                GalleryComponent("vCopyButton", "VCopyButton", keywords: ["copy", "clipboard"], description: "One-click copy button with animated checkmark success feedback."),
                GalleryComponent("vBusyIndicator", "VBusyIndicator", keywords: ["busy", "activity"], description: "Activity indicator for small, contained loading states."),
                GalleryComponent("vSkeletonBone", "VSkeletonBone", keywords: ["skeleton", "placeholder"], description: "Placeholder bone with shimmer animation for loading skeletons. Compose multiple bones to match the target layout."),
                GalleryComponent("vSkillTypePill", "VSkillTypePill", keywords: ["skill type", "pill"], description: "Colored pill showing a skill type category."),
                GalleryComponent("vInfoTooltip", "VInfoTooltip", keywords: ["info", "tooltip"], description: "Info icon with hover tooltip for contextual help text."),
            ]
        case .icons:
            return [
                GalleryComponent("vAppIconGenerator", "VAppIconGenerator", keywords: ["app icon", "generator"], description: "Generates deterministic app icons from SF Symbols with gradient backgrounds."),
                GalleryComponent("iconTokens", "VIcon", keywords: ["icon tokens", "icon catalog"], description: "Complete catalog of vendored Lucide icons. Use VIconView to render. See AGENTS.md for adding new icons."),
            ]
        case .inputs:
            return [
                GalleryComponent("vTextField", "VTextField", keywords: ["text field", "input"], description: "Single-line text input with label, error, secure mode, leading/trailing icons, size variants, custom font, and external focus control.", useInsteadOf: "Raw TextField or SecureField with manual styling"),
                GalleryComponent("vSlider", "VSlider", keywords: ["slider", "range"], description: "Custom slider with capsule track, grip-line thumb, and optional tick marks."),
                GalleryComponent("vTextEditor", "VTextEditor", keywords: ["text editor", "multiline"], description: "Multi-line text editor with placeholder and configurable min/max height."),
                GalleryComponent("vToggle", "VToggle", keywords: ["toggle", "switch"], description: "Custom toggle switch with optional label and animated knob transition."),
                GalleryComponent("vDropdown", "VDropdown", keywords: ["dropdown", "select", "picker"], description: "Generic dropdown picker with label, error, icon, and size variants (.regular, .small).", useInsteadOf: "Raw Menu + Picker with manual styling"),
                GalleryComponent("combinedForm", "Combined Form", keywords: ["form", "combined"], description: "Example of VTextField and VDropdown composed together in a form layout."),
            ]
        case .layout:
            return [
                GalleryComponent("vModal", "VModal", keywords: ["modal", "dialog"], description: "Standardized modal container with title, optional subtitle, scrollable content, and optional footer with navigation actions."),
                GalleryComponent("vAdaptiveStack", "VAdaptiveStack", keywords: ["adaptive stack", "responsive"], description: "Arranges content horizontally when space allows, falling back to vertical stacking via ViewThatFits.", useInsteadOf: "Raw ViewThatFits { HStack { } VStack { } } in feature code"),
                GalleryComponent("vSidePanel", "VSidePanel", keywords: ["side panel", "drawer"], description: "Side panel with title header, close button, optional pinned content, and scrollable body."),
                GalleryComponent("vSplitView", "VSplitView", keywords: ["split view", "resizable"], description: "Split layout with main content and a togglable, resizable side panel."),
                GalleryComponent("vAppWorkspaceDockLayout", "VAppWorkspaceDockLayout", keywords: ["dock", "workspace", "layout"], description: "Workspace layout with a togglable, resizable dock panel and draggable divider."),
            ]
        case .modifiers:
            return [
                GalleryComponent("vCardMod", ".vCard()", keywords: ["card modifier"], description: "Apply card styling (background, corner radius, border) to any view with configurable radius and background color."),
                GalleryComponent("pointerCursor", ".pointerCursor()", keywords: ["pointer", "cursor", "hand"], description: "Show pointing-hand cursor on hover. Uses native .pointerStyle(.link) on macOS 15+, falls back to NSCursor on macOS 14."),
                GalleryComponent("nativeTooltip", ".nativeTooltip()", keywords: ["native tooltip", "help"], description: "Attaches a native macOS tooltip via AppKit. Use instead of .help() where gesture recognizers block tooltip display."),
                GalleryComponent("vTooltip", ".vTooltip()", keywords: ["tooltip", "popover"], description: "Fast 200ms floating tooltip using NSPanel. Escapes clipping bounds, never steals clicks. Use for quick hints on any view."),
                GalleryComponent("vPanelBackground", ".vPanelBackground()", keywords: ["panel background"], description: "Fills the view with the subtle background color used for side panels and drawers."),
                GalleryComponent("ifMod", ".if()", keywords: ["conditional modifier"], description: "Conditionally applies a view transformation. Use sparingly — prefer named modifiers for common patterns."),
                GalleryComponent("vShimmer", ".vShimmer()", keywords: ["shimmer", "loading animation"], description: "Sweeps a translucent highlight across the view for skeleton loading animations. Respects reduced motion."),
                GalleryComponent("inlineWidgetCard", ".inlineWidgetCard()", keywords: ["inline widget", "card"], description: "Standard card chrome for inline chat widgets with padding, background, border, and optional hover highlight."),
            ]
        case .navigation:
            return [
                GalleryComponent("vSegmentedControl", "VSegmentedControl", keywords: ["segmented control", "tabs"], description: "Segmented control with underline, pill, or compact pill styles for switching between views."),
                GalleryComponent("vSidebarRow", "VSidebarRow", keywords: ["sidebar row", "navigation row"], description: "Sidebar navigation row with icon, label, hover/active states, trailing disclosure icon, and collapsed mode."),
                GalleryComponent("vTabBar", "VTabBar + VTab", keywords: ["tab bar", "tabs"], description: "Horizontal scrollable tab bar with pill, flat, and rectangular styles. Tabs support selection, close, and icons."),
                GalleryComponent("vThemeToggle", "VThemeToggle", keywords: ["theme toggle", "dark mode", "light mode"], description: "Three-way theme toggle (System / Light / Dark). Reads and writes themePreference in UserDefaults."),
            ]
        case .tokens:
            return [
                GalleryComponent("colors", "VColor", keywords: ["colors", "semantic colors", "theme"], description: "Adaptive semantic color tokens sourced from Figma. Each token resolves to a light/dark pair. Always use instead of raw Color values."),
                GalleryComponent("typography", "VFont", keywords: ["typography", "fonts", "text styles"], description: "Typography scale with Inter and DM Mono fonts. Includes body, headline, caption, mono, section, and display styles."),
                GalleryComponent("spacing", "VSpacing", keywords: ["spacing", "padding", "margins"], description: "4pt grid spacing tokens from xxs(2) to xxxl(48) with semantic aliases (inline, content, section, page)."),
                GalleryComponent("radius", "VRadius", keywords: ["radius", "corner radius", "rounded"], description: "Corner radius tokens from xs(2) to pill(999). Always use instead of raw cornerRadius values."),
                GalleryComponent("shadows", "VShadow", keywords: ["shadows", "elevation"], description: "Shadow tokens (sm, md, lg, glow, accentGlow) applied via .vShadow() modifier."),
                GalleryComponent("animations", "VAnimation", keywords: ["animations", "transitions", "motion"], description: "Animation timing presets: snappy (0.12s), fast (0.15s), standard (0.25s), slow (0.4s), spring, panel, bouncy."),
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

    private var filteredCategories: [(category: ComponentGalleryCategory, components: [GalleryComponent])] {
        let query = searchText.lowercased().trimmingCharacters(in: .whitespaces)
        if query.isEmpty {
            return ComponentGalleryCategory.allCases.map { ($0, $0.components) }
        }
        return ComponentGalleryCategory.allCases.compactMap { category in
            let matchingComponents = category.components.filter { component in
                component.title.lowercased().contains(query)
                    || component.id.lowercased().contains(query)
                    || component.description.lowercased().contains(query)
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
                Text("Component Gallery")
                    .font(VFont.sectionTitle)
                    .foregroundStyle(VColor.contentDefault)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.top, VSpacing.md)
                    .padding(.bottom, VSpacing.xs)

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
                            .foregroundStyle(VColor.contentTertiary)
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
    private func sidebarCategory(_ category: ComponentGalleryCategory, components: [GalleryComponent]) -> some View {
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
        GalleryOverview(category: category) { page in
            selectedPage = page
        }

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
    var useInsteadOf: String?

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text(title)
                .font(VFont.largeTitle)
                .foregroundStyle(VColor.contentDefault)
            Text(description)
                .font(VFont.body)
                .foregroundStyle(VColor.contentSecondary)
            if let useInsteadOf {
                HStack(spacing: VSpacing.xs) {
                    Text("Replaces")
                        .font(VFont.small)
                        .foregroundStyle(VColor.contentTertiary)
                    Text(useInsteadOf)
                        .font(VFont.small)
                        .foregroundStyle(VColor.contentTertiary)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xxs)
                        .background(VColor.surfaceActive)
                        .clipShape(Capsule())
                }
            }
        }
    }
}

// MARK: - Component Card

struct GalleryComponentCard: View {
    let component: GalleryComponent
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text(component.title)
                    .font(VFont.headline)
                    .foregroundStyle(VColor.contentDefault)

                Text(component.description)
                    .font(VFont.caption)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)

                Spacer(minLength: 0)

                if let useInsteadOf = component.useInsteadOf {
                    HStack(spacing: VSpacing.xs) {
                        Text("Replaces")
                            .font(VFont.small)
                            .foregroundStyle(VColor.contentTertiary)
                        Text(useInsteadOf)
                            .font(VFont.small)
                            .foregroundStyle(VColor.contentTertiary)
                            .lineLimit(1)
                            .padding(.horizontal, VSpacing.sm)
                            .padding(.vertical, VSpacing.xxs)
                            .background(VColor.surfaceActive)
                            .clipShape(Capsule())
                    }
                }
            }
            .frame(maxWidth: .infinity, minHeight: 100, alignment: .leading)
            .padding(VSpacing.lg)
        }
        .buttonStyle(.plain)
        .vCard()
        .pointerCursor()
    }
}

// MARK: - Overview Grid

struct GalleryOverview: View {
    let category: ComponentGalleryCategory
    let onNavigate: (GalleryPage) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            Text("\(category.rawValue) — \(category.components.count) components")
                .font(VFont.headline)
                .foregroundStyle(VColor.contentSecondary)

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 260, maximum: 400), spacing: VSpacing.md)], spacing: VSpacing.md) {
                ForEach(category.components) { component in
                    GalleryComponentCard(component: component) {
                        onNavigate(.component(category, component.id))
                    }
                }
            }
        }

        Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
    }
}

#endif
