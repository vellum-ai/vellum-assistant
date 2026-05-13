#if DEBUG
import SwiftUI
import VellumAssistantShared

struct HomeGallerySection: View {
    var filter: String?

    /// Register this gallery section with the shared gallery router.
    static func registerInGallery() {
        registerGalleryOverview(for: "home") {
            AnyView(HomeGallerySection())
        }
        registerGalleryComponentPage(for: "home") { componentID in
            AnyView(HomeGallerySection.componentPage(componentID))
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {

            // MARK: - MeetStatusPanel

            if filter == nil || filter == "meetStatusPanel" {
                GallerySectionHeader(
                    title: "MeetStatusPanel",
                    description: "Top-of-gallery banner that reflects live Meet bot state via meet.* SSE events. Idle state returns EmptyView."
                )

                VCard(background: VColor.surfaceBase) {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("Joining")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        MeetStatusPanel(
                            viewModel: MeetStatusPanelGalleryFixture.joining()
                        )

                        Divider().background(VColor.borderBase)

                        Text("In meeting")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        MeetStatusPanel(
                            viewModel: MeetStatusPanelGalleryFixture.joined()
                        )

                        Divider().background(VColor.borderBase)

                        Text("Error")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        MeetStatusPanel(
                            viewModel: MeetStatusPanelGalleryFixture.error()
                        )
                    }
                }

                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
            }

            // MARK: - HomeFeedGroupHeader

            if filter == nil || filter == "homeFeedGroupHeader" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomeFeedGroupHeader",
                    description: "Section header for time-bucketed feed groups (Today / Yesterday / Older)."
                )

                VCard(background: VColor.surfaceBase) {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        HomeFeedGroupHeader(label: "Today")
                        Divider().background(VColor.borderBase)
                        HomeFeedGroupHeader(label: "Yesterday")
                        Divider().background(VColor.borderBase)
                        HomeFeedGroupHeader(label: "Older")
                    }
                }
            }

            // MARK: - HomeRecapRow

            if filter == nil || filter == "homeRecapRow" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomeRecapRow",
                    description: "Compact row used in the time-bucketed Home feed. Tap to open detail; trailing Dismiss action is hover-only."
                )

                VCard(background: VColor.surfaceBase) {
                    VStack(spacing: VSpacing.xs) {
                        HomeRecapRow(
                            icon: .bell,
                            iconForeground: VColor.feedDigestStrong,
                            iconBackground: VColor.feedDigestWeak,
                            title: "While you were away, I ran the email clean job and deleted 26 emails…",
                            onDismiss: {},
                            onTap: {}
                        )

                        HomeRecapRow(
                            icon: .bell,
                            iconForeground: VColor.feedDigestStrong,
                            iconBackground: VColor.feedDigestWeak,
                            title: "There's also 4 low priority updates if you want to have a look.",
                            onDismiss: {},
                            onTap: {}
                        )
                    }
                }
            }

            // MARK: - HomeRecapGroupRow

            if filter == nil || filter == "homeRecapGroupRow" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomeRecapGroupRow",
                    description: "Grouped Home feed row: parent summary header with a nested list of child rows underneath. Used when HomeFeedGrouping collapses a run of 3+ low-priority items into a single card. Production wiring uses isExpanded: .constant(true); children are individually tappable."
                )

                VCard(background: VColor.surfaceBase) {
                    HomeRecapGroupRow(
                        parentIcon: .bell,
                        parentIconForeground: VColor.feedDigestStrong,
                        parentIconBackground: VColor.feedDigestWeak,
                        parentTitle: "There's also 4 low priority updates if you want to have a look.",
                        children: [
                            HomeRecapGroupRow.Child(
                                id: "gallery-child-1",
                                icon: .bell,
                                iconForeground: VColor.feedDigestStrong,
                                iconBackground: VColor.feedDigestWeak,
                                title: "This is the First notification in the group"
                            ),
                            HomeRecapGroupRow.Child(
                                id: "gallery-child-2",
                                icon: .bell,
                                iconForeground: VColor.feedDigestStrong,
                                iconBackground: VColor.feedDigestWeak,
                                title: "This is the Second notification in the group"
                            ),
                            HomeRecapGroupRow.Child(
                                id: "gallery-child-3",
                                icon: .bell,
                                iconForeground: VColor.feedDigestStrong,
                                iconBackground: VColor.feedDigestWeak,
                                title: "This is the Third notification in the group"
                            ),
                            HomeRecapGroupRow.Child(
                                id: "gallery-child-4",
                                icon: .bell,
                                iconForeground: VColor.feedDigestStrong,
                                iconBackground: VColor.feedDigestWeak,
                                title: "This is the Fourth notification in the group"
                            ),
                        ],
                        isExpanded: .constant(true),
                        onParentTap: {},
                        onChildTap: { _ in },
                        onParentDismiss: {},
                        onChildDismiss: { _ in }
                    )
                }
            }

            // MARK: - HomeDetailPanel

            if filter == nil || filter == "homeDetailPanel" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomeDetailPanel",
                    description: "Reusable white right-side panel container with a standardized header (icon + title + \"Go to Thread\" action + dismiss)."
                )

                HomeDetailPanel(
                    icon: .file,
                    title: "Panel title",
                    onGoToThread: {},
                    onDismiss: {}
                ) {
                    Text("Detail content goes here.")
                        .padding(VSpacing.lg)
                }
                .frame(height: 520)
            }

            // MARK: - HomeEmailEditor

            if filter == nil || filter == "homeEmailEditor" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomeEmailEditor",
                    description: "Pure body content for the email editor variant of the Home detail panel. Footer actions are right-aligned (Discard + primary). The primary CTA depends on Google OAuth state: \"Send\" when connected, otherwise a \"Connect to Google OAuth\" banner appears above the footer and the primary CTA becomes \"Copy to Clipboard\"."
                )

                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    Text("Google connected (primary = Send)")
                        .font(VFont.bodySmallEmphasised)
                        .foregroundStyle(VColor.contentSecondary)

                    HomeEmailEditorDemo(isGmailConnected: true)

                    Text("Google not connected (primary = Copy to Clipboard, banner visible)")
                        .font(VFont.bodySmallEmphasised)
                        .foregroundStyle(VColor.contentSecondary)

                    HomeEmailEditorDemo(isGmailConnected: false)
                }
            }

            // MARK: - HomeDocumentPreview

            if filter == nil || filter == "homeDocumentPreview" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomeDocumentPreview",
                    description: "Pure body content showing a document, image, or any file attachment preview in the Home detail panel. Optional right-aligned footer actions."
                )

                HomeDetailPanel(
                    icon: .file,
                    title: "preview.png",
                    onGoToThread: {},
                    onDismiss: {},
                    scrollable: false
                ) {
                    HomeDocumentPreview(
                        image: nil,
                        placeholderCaption: "Preview unavailable",
                        actions: [
                            .init(label: "Action", style: .outlined, action: {}),
                            .init(label: "Action", style: .primary, action: {})
                        ]
                    )
                }
                .frame(height: 520)
            }

            // MARK: - HomePermissionChatPreview

            if filter == nil || filter == "homePermissionChatPreview" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomePermissionChatPreview",
                    description: "Pure body content for the Home detail panel's permission-request variant — last user message, assistant preamble, and an inline tool confirmation bubble."
                )

                HomeDetailPanel(
                    icon: nil,
                    title: "Permission to access something",
                    onGoToThread: {},
                    onDismiss: {}
                ) {
                    HomePermissionChatPreview(
                        userMessage: "Can you transfer the funds for the annual subscription?",
                        assistantResponse: "Sure — I've drafted the transfer. Before I release it, I need your permission to authorize the payment.",
                        confirmation: ToolConfirmationData(
                            requestId: "preview-txn",
                            toolName: "payment_transfer",
                            input: [
                                "amount_usd": .init(5000),
                                "recipient": .init("Example Vendor")
                            ],
                            riskLevel: "medium"
                        ),
                        onAllow: {},
                        onDeny: {},
                        onAlwaysAllow: { _, _, _, _ in }
                    )
                }
                .frame(height: 520)
            }

            // MARK: - HomeSplitLayout

            if filter == nil || filter == "homeSplitLayout" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomeSplitLayout",
                    description: "Composite demo: home + right-side HomeDetailPanel showing the side-by-side layout. Use the toggle to flip the trailing content between the email editor, document preview, and permission chat."
                )

                HomeSplitLayoutDemo()
            }

            // MARK: - HomeSuggestionPillBar

            if filter == nil || filter == "homeSuggestionPillBar" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomeSuggestionPillBar",
                    description: "Dismissible \"by the way, have you tried…\" container with a headline and horizontal row of icon+label suggestion pills. Renders no pills when the suggestions array is empty."
                )

                VCard(background: VColor.surfaceBase) {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("With suggestions")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        HomeSuggestionPillBar(
                            headline: "By the way, have you tried one of these:",
                            suggestions: [
                                HomeSuggestion(
                                    id: "baby",
                                    icon: .gamepad,
                                    label: "App for baby names",
                                    prompt: "What apps for baby names should I try?"
                                ),
                                HomeSuggestion(
                                    id: "car",
                                    icon: .car,
                                    label: "Get your cars spring-ready",
                                    prompt: "Help me get my car spring-ready"
                                ),
                                HomeSuggestion(
                                    id: "vacation",
                                    icon: .plane,
                                    label: "Plan your next vacation",
                                    prompt: "Help me plan my next vacation"
                                ),
                            ],
                            onSelect: { _ in },
                            onDismiss: {}
                        )

                        Divider().background(VColor.borderBase)

                        Text("Empty suggestions (edge case — renders no pills)")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        HomeSuggestionPillBar(
                            headline: "By the way, have you tried one of these:",
                            suggestions: [],
                            onSelect: { _ in },
                            onDismiss: {}
                        )
                    }
                }
            }

            // MARK: - HomeGreetingHeader

            if filter == nil || filter == "homeGreetingHeader" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomeGreetingHeader",
                    description: "Home feed header with a leading avatar, a greeting title, and a trailing New Chat pill CTA."
                )

                VCard(background: VColor.surfaceBase) {
                    HomeGreetingHeader(
                        greeting: "Here's what's been going on",
                        onStartNewChat: {}
                    ) {
                        if let image = NSImage(systemSymbolName: "person.circle.fill", accessibilityDescription: nil) {
                            VAvatarImage(image: image, size: 40)
                        } else {
                            Circle()
                                .fill(VColor.surfaceActive)
                                .frame(width: 40, height: 40)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Demo helpers

/// Demo wrapper that hosts `HomeEmailEditor` inside a `HomeDetailPanel` with
/// sample content. Kept private to the gallery so it can own the `@State`
/// bindings required by the editor's field text.
///
/// The `isGmailConnected` flag flips the primary CTA between "Send" (when
/// true) and "Copy to Clipboard" with a visible "Connect to Google OAuth"
/// banner (when false). Default is true so the connected flow is shown
/// first.
private struct HomeEmailEditorDemo: View {
    private static let sampleAttachments: [HomeEmailEditor.Attachment] = [
        .init(id: UUID(), fileName: "report.pdf", fileSize: "24 kb"),
    ]

    let isGmailConnected: Bool

    @State private var toAddress: String = "user@example.com"
    @State private var subject: String = "Project Update"
    @State private var bodyText: String = """
    Hi there,

    Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.

    Best,
    Vellum
    """

    init(isGmailConnected: Bool = true) {
        self.isGmailConnected = isGmailConnected
    }

    var body: some View {
        HomeDetailPanel(
            icon: nil,
            title: "Email Draft",
            onGoToThread: {},
            onDismiss: {},
            scrollable: false
        ) {
            HomeEmailEditor(
                toAddress: $toAddress,
                subject: $subject,
                bodyText: $bodyText,
                attachments: Self.sampleAttachments,
                onAttachmentTap: { _ in },
                isGmailConnected: isGmailConnected,
                onSend: {},
                onCopyToClipboard: {},
                onDiscard: {},
                onConnectGoogle: {}
            )
        }
        .frame(height: 640)
    }
}

/// Demo wrapper that renders the side-by-side layout — a placeholder home
/// column on the leading side and either the email editor, document
/// preview, or permission chat on the trailing side, toggleable via a
/// segmented picker. `HomePageView` requires far too much setup
/// (`HomeStore`, `HomeFeedStore`, etc.) to make a realistic full demo
/// worthwhile here, so the leading column is intentionally a minimal
/// placeholder. The intent is to show the visual relationship between the
/// two columns, not to exercise the real home page.
private struct HomeSplitLayoutDemo: View {
    private enum Variant: String, CaseIterable, Identifiable {
        case email, document, permissionChat
        var id: String { rawValue }
        var label: String {
            switch self {
            case .email: return "Email editor"
            case .document: return "Document preview"
            case .permissionChat: return "Permission chat"
            }
        }
    }

    private static let sampleAttachments: [HomeEmailEditor.Attachment] = [
        .init(id: UUID(), fileName: "report.pdf", fileSize: "24 kb"),
    ]

    @State private var variant: Variant = .email
    @State private var toAddress: String = "user@example.com"
    @State private var subject: String = "Project Update"
    @State private var bodyText: String = """
    Hi there,

    Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.

    Best,
    Vellum
    """

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Picker("Trailing content", selection: $variant) {
                ForEach(Variant.allCases) { v in
                    Text(v.label).tag(v)
                }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 320)

            HStack(alignment: .top, spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("Home placeholder")
                        .font(VFont.titleSmall)
                        .foregroundStyle(VColor.contentSecondary)
                }
                .frame(maxWidth: .infinity)
                .padding(VSpacing.xxl)

                trailingPanel
            }
            .frame(height: 640)
        }
    }

    @ViewBuilder
    private var trailingPanel: some View {
        switch variant {
        case .email:
            HomeDetailPanel(
                icon: nil,
                title: "Thread Name Here",
                onGoToThread: {},
                onDismiss: {},
                scrollable: false
            ) {
                HomeEmailEditor(
                    toAddress: $toAddress,
                    subject: $subject,
                    bodyText: $bodyText,
                    attachments: Self.sampleAttachments,
                    onAttachmentTap: { _ in },
                    onSend: {},
                    onDiscard: {}
                )
            }
        case .document:
            HomeDetailPanel(
                icon: .file,
                title: "preview.png",
                onGoToThread: {},
                onDismiss: {},
                scrollable: false
            ) {
                HomeDocumentPreview(
                    image: nil,
                    placeholderCaption: "Preview unavailable",
                    actions: [
                        .init(label: "Action", style: .outlined, action: {}),
                        .init(label: "Action", style: .primary, action: {})
                    ]
                )
            }
        case .permissionChat:
            HomeDetailPanel(
                icon: nil,
                title: "Permission to access something",
                onGoToThread: {},
                onDismiss: {}
            ) {
                HomePermissionChatPreview(
                    userMessage: "Can you transfer the funds for the annual subscription?",
                    assistantResponse: "Sure — I've drafted the transfer. Before I release it, I need your permission to authorize the payment.",
                    confirmation: ToolConfirmationData(
                        requestId: "preview-txn",
                        toolName: "payment_transfer",
                        input: [
                            "amount_usd": .init(5000),
                            "recipient": .init("Example Vendor")
                        ],
                        riskLevel: "medium"
                    ),
                    onAllow: {},
                    onDeny: {},
                    onAlwaysAllow: { _, _, _, _ in }
                )
            }
        }
    }
}

// MARK: - Component Page Router

extension HomeGallerySection {
    @ViewBuilder
    static func componentPage(_ id: String) -> some View {
        switch id {
        case "meetStatusPanel": HomeGallerySection(filter: "meetStatusPanel")
        case "homeFeedGroupHeader": HomeGallerySection(filter: "homeFeedGroupHeader")
        case "homeRecapRow": HomeGallerySection(filter: "homeRecapRow")
        case "homeRecapGroupRow": HomeGallerySection(filter: "homeRecapGroupRow")
        case "homeDetailPanel": HomeGallerySection(filter: "homeDetailPanel")
        case "homeEmailEditor": HomeGallerySection(filter: "homeEmailEditor")
        case "homeDocumentPreview": HomeGallerySection(filter: "homeDocumentPreview")
        case "homePermissionChatPreview": HomeGallerySection(filter: "homePermissionChatPreview")
        case "homeSplitLayout": HomeGallerySection(filter: "homeSplitLayout")
        case "homeSuggestionPillBar": HomeGallerySection(filter: "homeSuggestionPillBar")
        case "homeGreetingHeader": HomeGallerySection(filter: "homeGreetingHeader")
        default: EmptyView()
        }
    }
}

// MARK: - Gallery Fixtures

/// Builds `MeetStatusViewModel` instances in each presentation state so the
/// gallery can render the panel without a live SSE stream. Lives here rather
/// than on the view model itself so the production target stays free of
/// test/gallery-only wiring.
@MainActor
private enum MeetStatusPanelGalleryFixture {
    private static func empty() -> AsyncStream<ServerMessage> {
        AsyncStream<ServerMessage> { _ in }
    }

    static func joining() -> MeetStatusViewModel {
        let vm = MeetStatusViewModel(messageStream: empty())
        vm.handle(.meetJoining(
            MeetJoiningMessage(
                type: "meet.joining",
                meetingId: "demo-joining",
                url: "https://meet.google.com/demo-joining"
            )
        ))
        return vm
    }

    static func joined() -> MeetStatusViewModel {
        let vm = MeetStatusViewModel(
            messageStream: empty(),
            clock: { Date(timeIntervalSinceNow: -73) }
        )
        vm.handle(.meetJoining(
            MeetJoiningMessage(
                type: "meet.joining",
                meetingId: "demo-joined",
                url: "https://meet.google.com/demo-joined"
            )
        ))
        vm.handle(.meetJoined(
            MeetJoinedMessage(type: "meet.joined", meetingId: "demo-joined")
        ))
        return vm
    }

    static func error() -> MeetStatusViewModel {
        let vm = MeetStatusViewModel(messageStream: empty())
        vm.handle(.meetError(
            MeetErrorMessage(
                type: "meet.error",
                meetingId: "demo-error",
                detail: "Bot container exited unexpectedly"
            )
        ))
        return vm
    }
}
#endif
