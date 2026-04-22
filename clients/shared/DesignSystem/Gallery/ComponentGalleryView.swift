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
    case home = "Home"
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
        case .home: return .house
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

                GalleryComponent("subagentStatus", "SubagentStatusChip", keywords: ["subagent status", "subagent conversation"], description: "Status chip for subagent conversations showing name and activity state."),
                GalleryComponent("toolChips", "ToolCallChip", keywords: ["tool chips", "tool call"], description: "Compact chip showing a tool call with name, status icon, and optional duration."),
                GalleryComponent("stepIndicators", "CurrentStepIndicator", keywords: ["step indicators", "progress bar", "tool call progress"], description: "Progress bar showing the current step in a multi-step tool call."),
                GalleryComponent("progressIndicators", "TypingIndicatorView", keywords: ["progress indicators", "typing", "running"], description: "Animated dots indicating the assistant is typing or processing."),
                GalleryComponent("toolConfirmations", "ToolConfirmationBubble", keywords: ["tool confirmations", "permission", "approval"], description: "Approval bubble for tool calls that require user permission before execution."),
                GalleryComponent("surfaceActions", "Surface Action Buttons", keywords: ["surface actions", "action pills", "inline buttons", "pick something"], description: "Inline action pills in assistant bubbles letting users pick from options. Supports secondary, primary, and destructive styles."),
                GalleryComponent("chatConversationErrorToast", "ChatConversationErrorToast", keywords: ["error toast", "above composer", "conversation error", "retry"], description: "Unified error toast rendered above the chat composer. Solid-accent background with white text; category-driven icon, color, and retry label for typed ConversationError, plus an unstructured init for custom icon/color/action."),
                GalleryComponent("creditsExhaustedBanner", "CreditsExhaustedBanner", keywords: ["credits exhausted", "balance", "add funds", "above composer"], description: "Surface-colored above-composer panel shown when the user's balance runs out. Title + subtitle + primary \"Add Funds\" CTA."),
                GalleryComponent("compactionCircuitOpenBanner", "CompactionCircuitOpenBanner", keywords: ["compaction", "circuit open", "auto-compaction paused", "cooldown"], description: "Solid-accent warning banner shown when auto-compaction is paused after repeated summary failures. No buttons — auto-dismisses on a 1-minute ticker once openUntil elapses."),
                GalleryComponent("missingApiKeyBanner", "MissingApiKeyBanner", keywords: ["missing api key", "api key", "open settings", "above composer"], description: "Surface-colored above-composer panel with a top-right dismiss, title, subtitle, and a full-width \"Open Settings\" CTA."),
            ]
        case .display:
            return [
                GalleryComponent("vCard", "VCard", keywords: ["card"], description: "Container with surface background, border, and configurable padding. Use .vCard() modifier for simple wrapping.", useInsteadOf: "Manual padding + background + cornerRadius"),
                GalleryComponent("vAppCard", "VAppCard", keywords: ["app card", "app tile", "skill card"], description: "App-tile card with preview thumbnail, title, description, and a button row (Open / Pin / secondary icon). Matches the Figma App Card spec."),

                GalleryComponent("vEmptyState", "VEmptyState", keywords: ["empty state"], description: "Centered placeholder with icon, title, subtitle, and optional action button for empty content areas."),
                GalleryComponent("vDisclosureSection", "VDisclosureSection", keywords: ["disclosure", "collapsible"], description: "Full-row clickable disclosure with animated chevron. Replaces DisclosureGroup.", useInsteadOf: "Raw DisclosureGroup"),
                GalleryComponent("vListRow", "VListRow", keywords: ["list row"], description: "List item with hover highlight and optional tap action."),
                GalleryComponent("vAvatarImage", "VAvatarImage", keywords: ["avatar", "image"], description: "Avatar with transparency-aware clip shape. Transparent images show full artwork; opaque images clip to a circle."),
                GalleryComponent("animatedAvatar", "AnimatedAvatarView", keywords: ["avatar", "animated", "character", "streaming", "morph"], description: "Live-rendered avatar with CAShapeLayer. Supports breathing, blinking, poke, and streaming body-morph animations."),
                GalleryComponent("vCodeView", "VCodeView", keywords: ["code view", "syntax"], description: "Read-only code viewer with line numbers, search, and pluggable syntax highlighting. Wraps NSTextView for native text selection."),
                GalleryComponent("vSelectableTextView", "VSelectableTextView", keywords: ["selectable", "text", "copy", "selection"], description: "Read-only selectable text wrapping NSTextView for native text selection and copy in lazy containers."),
                GalleryComponent("vDiffView", "VDiffView", keywords: ["diff view"], description: "Renders unified diff text with per-line colored backgrounds. Green for additions, red for removals."),
                GalleryComponent("vStreamingWaveform", "VStreamingWaveform", keywords: ["waveform", "streaming"], description: "Animated audio waveform driven by amplitude. Two styles: conversation (centered) and dictation (bottom-aligned)."),
                GalleryComponent("vFileBrowser", "VFileBrowser", keywords: ["file browser", "file tree", "tree"], description: "Two-pane file browser with a tree-based file list, header actions slot, search with auto-expand, and caller-provided right pane content."),
                GalleryComponent("vMarqueeText", "VMarqueeText", keywords: ["marquee", "scroll", "truncation", "hover", "overflow"], description: "Horizontally scrolling text that reveals truncated content on hover. Uses programmatic NSFont measurement for zero extra layout overhead."),
            ]
        case .feedback:
            return [
                GalleryComponent("vBadge", "VBadge", keywords: ["badge"], description: "Notification count badge with semantic color variants."),
                GalleryComponent("vTag", "VTag", keywords: ["tag", "category", "kind"], description: "Colored tag for categorizing items with pastel backgrounds."),
                GalleryComponent("vLoadingIndicator", "VLoadingIndicator", keywords: ["loading", "spinner"], description: "Spinning indicator for inline loading states. Use VSkeletonBone for structured loading layouts."),
                GalleryComponent("vToast", "VToast", keywords: ["toast", "notification"], description: "Temporary notification banner with auto-dismiss and action support."),
                GalleryComponent("vNotification", "VNotification", keywords: ["notification", "banner", "notice", "alert bar", "inline status"], description: "Compact single-line notification bar with tone, optional action, and dismiss. Use when you need a slim inline or pinned status indicator — smaller than VToast, more actionable than VInlineMessage."),
                GalleryComponent("vInlineMessage", "VInlineMessage", keywords: ["inline message", "alert"], description: "Persistent inline alert with icon and semantic color (info, warning, error, success)."),
                GalleryComponent("vShortcutTag", "VShortcutTag", keywords: ["shortcut", "keyboard"], description: "Keyboard shortcut display tag showing key combinations."),
                GalleryComponent("vCopyButton", "VCopyButton", keywords: ["copy", "clipboard"], description: "One-click copy button with animated checkmark success feedback."),
                GalleryComponent("vBusyIndicator", "VBusyIndicator", keywords: ["busy", "activity"], description: "Activity indicator for small, contained loading states."),
                GalleryComponent("vSkeletonBone", "VSkeletonBone", keywords: ["skeleton", "placeholder"], description: "Placeholder bone with shimmer animation for loading skeletons. Compose multiple bones to match the target layout."),
                GalleryComponent("vSkillTypePill", "VSkillTypePill", keywords: ["skill type", "pill"], description: "Colored pill showing a skill type category."),
                GalleryComponent("vPaidBadge", "VPaidBadge", keywords: ["paid", "badge", "dollar"], description: "Pill badge marking an integration or feature as paid."),
                GalleryComponent("vInfoTooltip", "VInfoTooltip", keywords: ["info", "tooltip"], description: "Info icon with hover tooltip for contextual help text."),
                GalleryComponent("vContextWindowIndicator", "VContextWindowIndicator", keywords: ["context window", "progress", "ring"], description: "Circular ring showing context window fill level with hover popover."),
            ]
        case .home:
            return [
                GalleryComponent("recapPill", "RecapPillView", keywords: ["pill", "chip", "inline", "recap"], description: "Inline interactive pill for recap text"),
                GalleryComponent("homeAuthCard", "HomeAuthCard", keywords: ["auth", "authorise", "deny", "payment"], description: "Payment authorisation action card"),
                GalleryComponent("homePermissionCard", "HomePermissionCard", keywords: ["permission", "tool", "action"], description: "Tool permission request card"),
                GalleryComponent("homeAssistantCard", "HomeAssistantCard", keywords: ["assistant", "a2a", "agent"], description: "Assistant-to-assistant message card"),
                GalleryComponent("homeReplyCard", "HomeReplyCard", keywords: ["reply", "composer", "input"], description: "Reply prompt with inline composer"),
                GalleryComponent("homeEmailPreviewCard", "HomeEmailPreviewCard", keywords: ["email", "draft", "preview"], description: "Email draft preview card"),
                GalleryComponent("homeImageCard", "HomeImageCard", keywords: ["image", "photo", "preview"], description: "Image preview card"),
                GalleryComponent("homeFileCard", "HomeFileCard", keywords: ["file", "document", "attachment"], description: "File reference card"),
                GalleryComponent("homeUpdatesListCard", "HomeUpdatesListCard", keywords: ["updates", "list", "grouped"], description: "Grouped update notifications card"),
                GalleryComponent("homeFeedGroupHeader", "HomeFeedGroupHeader", keywords: ["feed", "group", "header", "section", "today", "yesterday"], description: "Section header for time-bucketed feed groups (Today / Yesterday / Older)."),
                GalleryComponent("homeRecapRow", "HomeRecapRow", keywords: ["recap", "row", "feed", "bucket"], description: "Compact row used in the time-bucketed Home feed with tinted icon and optional trailing action."),
                GalleryComponent(
                    "homeRecapGroupRow",
                    "HomeRecapGroupRow",
                    keywords: ["recap", "group", "row", "feed", "collapsed", "low priority", "digest"],
                    description: "Grouped Home feed row: parent summary header with a nested list of child rows. Used when HomeFeedGrouping collapses 3+ contiguous low-priority digests into a single card."
                ),
                GalleryComponent(
                    "homeDetailPanel",
                    "HomeDetailPanel",
                    keywords: ["detail panel", "side panel", "home", "container"],
                    description: "Reusable white right-side panel container with standardized header (icon + title + primary/secondary actions + dismiss)."
                ),
                GalleryComponent(
                    "homeScheduledDetailPanel",
                    "HomeScheduledDetailPanel",
                    keywords: ["scheduled", "detail panel", "thread", "calendar", "home"],
                    description: "Right-hand detail panel surfaced when a scheduled (.thread, source: .calendar) feed item is tapped. Shows schedule metadata (Name, Syntax, Mode, Schedule, Enabled, Next Run) plus outlined secondary + filled primary actions."
                ),
                GalleryComponent(
                    "homeNudgeDetailPanel",
                    "HomeNudgeDetailPanel",
                    keywords: ["nudge", "detail panel", "cards", "issues", "heartbeat", "home"],
                    description: "Right-hand detail panel surfaced when a .nudge feed item is tapped. Description + stack of N cards with optional action buttons, plus a right-aligned footer with secondary + primary actions (e.g. Clear All / Resolve All)."
                ),
                GalleryComponent(
                    "homeEmailEditor",
                    "HomeEmailEditor",
                    keywords: ["email editor", "compose", "side panel", "detail"],
                    description: "Pure body content for the email editor variant of the Home detail panel."
                ),
                GalleryComponent(
                    "homeDocumentPreview",
                    "HomeDocumentPreview",
                    keywords: ["document", "preview", "image", "attachment", "file", "invoice", "detail"],
                    description: "Pure body content showing a document, image, or any file attachment preview in the Home detail panel. Optional right-aligned footer actions."
                ),
                GalleryComponent(
                    "homePermissionChatPreview",
                    "HomePermissionChatPreview",
                    keywords: ["permission", "chat", "confirmation", "tool", "preview", "detail"],
                    description: "Pure body content for the Home detail panel's permission-request variant — last user message, assistant preamble, and an inline tool confirmation bubble."
                ),
                GalleryComponent(
                    "homeSplitLayout",
                    "HomeSplitLayout",
                    keywords: ["home", "split", "side by side", "layout"],
                    description: "Composite demo: home + right-side HomeDetailPanel showing the side-by-side layout."
                ),
                GalleryComponent(
                    "homeSuggestionPillBar",
                    "HomeSuggestionPillBar",
                    keywords: ["suggestion", "pill", "bar", "have you tried", "home"],
                    description: "Dismissible \"by the way, have you tried…\" container with a headline and horizontal row of icon+label suggestion pills."
                ),
                GalleryComponent(
                    "homeGreetingHeader",
                    "HomeGreetingHeader",
                    keywords: ["greeting", "header", "home", "avatar", "new chat"],
                    description: "Home feed header with a leading avatar, a greeting title, and a trailing New Chat pill CTA."
                ),
                GalleryComponent(
                    "homeFeedFilterBar",
                    "HomeFeedFilterBar",
                    keywords: ["filter", "chip", "home", "feed", "type", "toggle"],
                    description: "Row of 4 toggleable 26pt icon chips (Heartbeat / Input / Notification / Schedule) used to filter the Home feed by type."
                ),
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
                GalleryComponent("vPageContainer", "VPageContainer", keywords: ["page container", "panel layout"], description: "Standard page container with title, consistent spacing, surfaceOverlay background, and rounded corners. Use for full-width panel pages."),
                GalleryComponent("vSidePanel", "VSidePanel", keywords: ["side panel", "drawer"], description: "Side panel with title header, close button, optional pinned content, and scrollable body."),
                GalleryComponent("vSplitView", "VSplitView", keywords: ["split view", "resizable"], description: "Split layout with main content and a togglable, resizable side panel."),
                GalleryComponent("vAppWorkspaceDockLayout", "VAppWorkspaceDockLayout", keywords: ["dock", "workspace", "layout"], description: "Workspace layout with a togglable, resizable dock panel and draggable divider."),
            ]
        case .modifiers:
            return [
                GalleryComponent("vCardMod", ".vCard()", keywords: ["card modifier"], description: "Apply card styling (background, corner radius, border) to any view with configurable radius and background color."),
                GalleryComponent("pointerCursor", ".pointerCursor()", keywords: ["pointer", "cursor", "hand"], description: "Show pointing-hand cursor on hover. Uses native .pointerStyle(.link)."),
                GalleryComponent("nativeTooltip", ".nativeTooltip()", keywords: ["native tooltip", "help"], description: "Attaches a native macOS tooltip via AppKit. Use instead of .help() where gesture recognizers block tooltip display."),
                GalleryComponent("vTooltip", ".vTooltip()", keywords: ["tooltip", "popover"], description: "Fast 200ms floating tooltip using NSPanel. Escapes clipping bounds, never steals clicks. Use for quick hints on any view."),
                GalleryComponent("vPanelBackground", ".vPanelBackground()", keywords: ["panel background"], description: "Fills the view with the subtle background color used for side panels and drawers."),
                GalleryComponent("ifMod", ".if()", keywords: ["conditional modifier"], description: "Conditionally applies a view transformation. Use sparingly — prefer named modifiers for common patterns."),
                GalleryComponent("vShimmer", ".vShimmer()", keywords: ["shimmer", "loading animation"], description: "Sweeps a translucent highlight across the view for skeleton loading animations. Respects reduced motion."),
                GalleryComponent("inlineWidgetCard", ".inlineWidgetCard()", keywords: ["inline widget", "card"], description: "Standard card chrome for inline chat widgets with padding, background, border, and optional hover highlight."),
                GalleryComponent("onRightClick", ".onRightClick()", keywords: ["right click", "right-click", "secondary click", "context"], description: "Detects right-click (secondary click) and reports screen-coordinate position. Does not interfere with left-click, hover, or drag."),
                GalleryComponent("vContextMenu", ".vContextMenu()", keywords: ["context menu", "right click", "right-click", "secondary click"], description: "Custom context menu using VMenu that appears on right-click. Menu items auto-dismiss. Uses a floating NSPanel for correct z-order and positioning.", useInsteadOf: ".contextMenu { } when you want VMenu styling"),
            ]
        case .navigation:
            return [
                GalleryComponent("vSegmentedControl", "VTabs", keywords: ["segmented control", "tabs", "underline"], description: "Underline-style tab bar for switching between major views."),
                GalleryComponent("vNavItem", "VNavItem", keywords: ["sidebar row", "navigation row"], description: "Sidebar navigation row with icon, label, hover/active states, trailing disclosure icon, and collapsed mode."),
                GalleryComponent("vLink", "VLink", keywords: ["link", "url", "external link", "hyperlink"], description: "Styled external link that opens a URL in the default browser. Applies pointer cursor, single-line truncation, and caption font by default."),
                GalleryComponent("vSegmentControl", "VSegmentControl", keywords: ["segment control", "pill tabs", "theme toggle", "dark mode"], description: "Segmented control with pill-style segments for filtering and selection. Supports text and icon content."),
                GalleryComponent("vMenu", "VMenu", keywords: ["menu", "popover", "dropdown", "drawer", "overflow"], description: "Reusable popover container with section headers, dividers, action items, and custom rows. Use instead of manual drawer chrome."),
                GalleryComponent("vSubMenuItem", "VSubMenuItem", keywords: ["submenu", "cascading menu", "nested menu", "flyout"], description: "Cascading submenu item that opens a child VMenuPanel on hover/click. Anchored positioning with screen-edge flip, grace-period close. iOS falls back to native SwiftUI Menu."),
            ]
        case .tokens:
            return [
                GalleryComponent("colors", "VColor", keywords: ["colors", "semantic colors", "theme"], description: "Adaptive semantic color tokens sourced from Figma. Each token resolves to a light/dark pair. Always use instead of raw Color values."),
                GalleryComponent("typography", "VFont", keywords: ["typography", "fonts", "text styles"], description: "DM Sans typography scale matching Figma. Includes title, body, label, and chat tokens."),
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
    /// Registry for platform-specific gallery overview sections (e.g. macOS-only Home components).
    nonisolated(unsafe) static var externalOverviewFactories: [String: () -> AnyView] = [:]
    /// Registry for platform-specific gallery component detail pages.
    nonisolated(unsafe) static var externalComponentPageFactories: [String: (String) -> AnyView] = [:]

    @State private var selectedPage: GalleryPage? = .overview(.buttons)
    @State private var searchText: String = ""
    @State private var expandedCategories: Set<ComponentGalleryCategory> = [.buttons]
    @AppStorage("themePreference") private var themePreference: String = "system"

    private var themeBinding: Binding<String> {
        Binding(
            get: { themePreference },
            set: { themePreference = $0; VTheme.applyTheme($0) }
        )
    }

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
                    .font(VFont.titleSmall)
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

                VSegmentControl(
                    items: [
                        (label: "System", icon: VIcon.monitor.rawValue, tag: "system"),
                        (label: "Light", icon: VIcon.sun.rawValue, tag: "light"),
                        (label: "Dark", icon: VIcon.moon.rawValue, tag: "dark"),
                    ],
                    selection: themeBinding
                )
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
            .background(VColor.surfaceBase)
        }
    }

    // MARK: - Sidebar Components

    @ViewBuilder
    private func sidebarCategory(_ category: ComponentGalleryCategory, components: [GalleryComponent]) -> some View {
        let isCategoryExpanded = isSearching || expandedCategories.contains(category)

        VStack(spacing: 0) {
            VNavItem(
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

        return VNavItem(
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
        case .chat:
            // Render the shared chat sections first, then append any
            // platform-specific sections registered for the "chat" category
            // (mirrors the .home extensibility pattern). Platform-local
            // sections filter themselves so they no-op for filters the
            // shared section handles.
            ChatGallerySection()
            if let factory = ComponentGalleryView.externalOverviewFactories["chat"] {
                factory()
            }
        case .display: DisplayGallerySection()
        case .feedback: FeedbackGallerySection()
        case .home:
            if let factory = ComponentGalleryView.externalOverviewFactories["home"] {
                factory()
            }
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
        case .chat:
            // Render both the shared and external component pages — each
            // emits EmptyView for IDs it doesn't own, so at most one
            // produces visible content. See `.chat` overview case above.
            ChatGallerySection.componentPage(componentID)
            if let factory = ComponentGalleryView.externalComponentPageFactories["chat"] {
                factory(componentID)
            }
        case .display: DisplayGallerySection.componentPage(componentID)
        case .feedback: FeedbackGallerySection.componentPage(componentID)
        case .home:
            if let factory = ComponentGalleryView.externalComponentPageFactories["home"] {
                factory(componentID)
            }
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

public struct GallerySectionHeader: View {
    public let title: String
    public let description: String
    public var useInsteadOf: String?

    public init(title: String, description: String, useInsteadOf: String? = nil) {
        self.title = title
        self.description = description
        self.useInsteadOf = useInsteadOf
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text(title)
                .font(VFont.titleLarge)
                .foregroundStyle(VColor.contentDefault)
            Text(description)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
            if let useInsteadOf {
                HStack(spacing: VSpacing.xs) {
                    Text("Replaces")
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.contentTertiary)
                    Text(useInsteadOf)
                        .font(VFont.labelSmall)
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
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentDefault)

                Text(component.description)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)

                Spacer(minLength: 0)

                if let useInsteadOf = component.useInsteadOf {
                    HStack(spacing: VSpacing.xs) {
                        Text("Replaces")
                            .font(VFont.labelSmall)
                            .foregroundStyle(VColor.contentTertiary)
                        Text(useInsteadOf)
                            .font(VFont.labelSmall)
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
                .font(VFont.bodySmallEmphasised)
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

/// Register an external gallery overview factory for a category.
/// Used by platform-specific targets to inject gallery sections for
/// categories whose components live outside the shared module.
public func registerGalleryOverview(for categoryKey: String, factory: @escaping () -> AnyView) {
    ComponentGalleryView.externalOverviewFactories[categoryKey] = factory
}

/// Register an external gallery component page factory for a category.
/// Used by platform-specific targets to inject component detail pages.
public func registerGalleryComponentPage(for categoryKey: String, factory: @escaping (String) -> AnyView) {
    ComponentGalleryView.externalComponentPageFactories[categoryKey] = factory
}

#endif
