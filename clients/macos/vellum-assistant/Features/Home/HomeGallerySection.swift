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

            // MARK: - RecapPillView

            if filter == nil || filter == "recapPill" {
                GallerySectionHeader(
                    title: "RecapPillView",
                    description: "Inline interactive pill for recap text with optional priority icon."
                )

                VCard(background: VColor.surfaceBase) {
                    HStack(spacing: VSpacing.lg) {
                        RecapPillView(text: "3 payments", priority: .high)
                        RecapPillView(text: "2 emails", priority: .medium)
                        RecapPillView(text: "5 updates")
                    }
                }
            }

            // MARK: - HomeAuthCard

            if filter == nil || filter == "homeAuthCard" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomeAuthCard",
                    description: "Payment authorisation action card with Authorise/Deny buttons."
                )

                VCard(background: VColor.surfaceBase) {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("Simple variant")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        HomeAuthCard(
                            title: "Authorise $42.00 payment",
                            onAuthorise: {},
                            onDeny: {}
                        )

                        Divider().background(VColor.borderBase)

                        Text("Rich variant (with subtitle + attachment)")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        HomeAuthCard(
                            title: "Authorise $128.50 payment",
                            subtitle: "Invoice #2024-0391",
                            attachment: (fileName: "invoice-2024-0391.pdf", fileSize: "245 KB"),
                            onAuthorise: {},
                            onDeny: {},
                            onDismiss: {}
                        )
                    }
                }
            }

            // MARK: - HomePermissionCard

            if filter == nil || filter == "homePermissionCard" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomePermissionCard",
                    description: "Tool permission request card with action details and Authorise/Deny buttons."
                )

                VCard(background: VColor.surfaceBase) {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("With content")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        HomePermissionCard(
                            title: "Need your permission here my man",
                            threadName: "Thread Name",
                            toolActionTitle: "Looking at the most recent files in your Downloads Folder",
                            toolActionDescription: "Allow running a command on your computer looking at the most recent files in your Downloads folder?",
                            onAuthorise: {},
                            onDeny: {},
                            onDismiss: {}
                        )

                        Divider().background(VColor.borderBase)

                        Text("Without content")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        HomePermissionCard(
                            title: "Need your permission to continue",
                            threadName: "Thread Name",
                            onAuthorise: {},
                            onDeny: {},
                            onDismiss: {}
                        )
                    }
                }
            }

            // MARK: - HomeAssistantCard

            if filter == nil || filter == "homeAssistantCard" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomeAssistantCard",
                    description: "Assistant-to-assistant message card with Allow Once/Deny actions."
                )

                VCard(background: VColor.surfaceBase) {
                    HomeAssistantCard(
                        title: "John’s assistant wants to send a message to your assistant",
                        threadName: "Thread Name",
                        onAuthorise: {},
                        onDeny: {},
                        onDismiss: {}
                    )
                }
            }

            // MARK: - HomeReplyCard

            if filter == nil || filter == "homeReplyCard" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomeReplyCard",
                    description: "Reply prompt with inline composer for responding to assistant questions."
                )

                VCard(background: VColor.surfaceBase) {
                    HomeReplyCard(
                        title: "What time should I schedule the meeting?",
                        threadName: "Calendar Management",
                        onDismiss: {},
                        onSend: { _ in }
                    )
                }
            }

            // MARK: - HomeEmailPreviewCard

            if filter == nil || filter == "homeEmailPreviewCard" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomeEmailPreviewCard",
                    description: "Email draft preview card with to/subject/body fields and Send/Rework actions."
                )

                VCard(background: VColor.surfaceBase) {
                    HomeEmailPreviewCard(
                        title: "Draft email ready",
                        threadName: "Client Follow-up",
                        toAddress: "client@example.com",
                        subject: "Project Update - Q4 Milestones",
                        bodyText: """
                        Dear Whatsyourface,

                        Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.

                        Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.

                        Best,
                        Rok
                        """,
                        onSend: {},
                        onRework: {},
                        onDismiss: {}
                    )
                }
            }

            // MARK: - HomeImageCard

            if filter == nil || filter == "homeImageCard" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomeImageCard",
                    description: "Image preview card with Save and Find a New One actions."
                )

                VCard(background: VColor.surfaceBase) {
                    HomeImageCard(
                        title: "Generated chart preview",
                        threadName: "Data Analysis",
                        image: nil,
                        onSave: {},
                        onFindNew: {},
                        onDismiss: {}
                    )
                }
            }

            // MARK: - HomeFileCard

            if filter == nil || filter == "homeFileCard" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomeFileCard",
                    description: "File reference card showing file name and size."
                )

                VCard(background: VColor.surfaceBase) {
                    HomeFileCard(
                        title: "File saved",
                        threadName: "Document Processing",
                        fileName: "quarterly-report.pdf",
                        fileSize: "1.2 MB",
                        onDismiss: {}
                    )
                }
            }

            // MARK: - HomeUpdatesListCard

            if filter == nil || filter == "homeUpdatesListCard" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomeUpdatesListCard",
                    description: "Grouped update notifications card with a list of items."
                )

                VCard(background: VColor.surfaceBase) {
                    HomeUpdatesListCard(
                        updates: [
                            .init(icon: .mail, title: "New email from Alice", threadName: "Inbox"),
                            .init(icon: .file, title: "Report generated", threadName: "Analytics"),
                            .init(icon: .circleCheck, title: "Deployment complete", threadName: "DevOps"),
                            .init(icon: .messageCircle, title: "New message in thread", threadName: "Team Chat"),
                        ],
                        onClearAll: {},
                        onSelectUpdate: { _ in }
                    )
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
                    description: "Compact row used in the time-bucketed Home feed. Icon tint communicates severity; optional trailing Action button is isolated from the row tap."
                )

                VCard(background: VColor.surfaceBase) {
                    VStack(spacing: VSpacing.xs) {
                        // Heartbeat (nudge): danger/red tint.
                        HomeRecapRow(
                            icon: .heart,
                            iconForeground: VColor.systemNegativeStrong,
                            iconBackground: VColor.systemNegativeWeak,
                            title: "Heartbeat – all systems healthy",
                            onDismiss: {},
                            onTap: {}
                        )

                        // Permission (action): info/blue tint.
                        HomeRecapRow(
                            icon: .arrowLeft,
                            iconForeground: VColor.systemInfoStrong,
                            iconBackground: VColor.systemInfoWeak,
                            title: "I need your permission on authorising a transaction to NBA",
                            onDismiss: {},
                            onTap: {}
                        )

                        // Digest: emerald/positive tint.
                        HomeRecapRow(
                            icon: .bell,
                            iconForeground: VColor.systemPositiveStrong,
                            iconBackground: VColor.systemPositiveWeak,
                            title: "Last, while you were away, I ran the email clean job and deleted 26 emails…",
                            onDismiss: {},
                            onTap: {}
                        )

                        // Thread (schedule): amber/mid tint.
                        HomeRecapRow(
                            icon: .calendar,
                            iconForeground: VColor.systemMidStrong,
                            iconBackground: VColor.systemMidWeak,
                            title: "There's also 4 low priority updates if you want to have a look.",
                            onDismiss: {},
                            onTap: {}
                        )
                    }
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
                    description: "Pure body content for the email editor variant of the Home detail panel."
                )

                HomeEmailEditorDemo()
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
                    title: "Porsche-preview-2.4S.png",
                    onGoToThread: {},
                    onDismiss: {}
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
                        userMessage: "Can you send $5,000 to NBA Merchandising for the annual subscription?",
                        assistantResponse: "Sure — I've drafted the transfer on Stripe. Before I release it, I need your permission to authorize the payment.",
                        confirmation: ToolConfirmationData(
                            requestId: "preview-nba-txn",
                            toolName: "stripe_transfer",
                            input: [
                                "amount_usd": .init(5000),
                                "recipient": .init("NBA Merchandising")
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
                    description: "Composite demo: home + right-side HomeDetailPanel showing the side-by-side layout. Use the toggle to flip the trailing content between the email editor and the invoice preview."
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

            // MARK: - HomeFeedFilterBar

            if filter == nil || filter == "homeFeedFilterBar" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomeFeedFilterBar",
                    description: "Row of 4 toggleable 26pt icon chips (Heartbeat / Input / Notification / Schedule) used to filter the Home feed. Empty selection means show everything; non-empty is an inclusion filter."
                )

                VCard(background: VColor.surfaceBase) {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("No selection (all chips inactive)")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        HomeFeedFilterBar(
                            selected: nil,
                            onToggle: { _ in }
                        )

                        Divider().background(VColor.borderBase)

                        Text("Heartbeat selected (single-select)")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        HomeFeedFilterBar(
                            selected: .nudge,
                            onToggle: { _ in }
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
/// sample content matching the Figma mock (thread name, recipient, subject,
/// body, and a single attachment). Kept private to the gallery so it can
/// own the `@State` bindings required by the editor's field text.
private struct HomeEmailEditorDemo: View {
    private static let sampleAttachments: [HomeEmailEditor.Attachment] = [
        .init(id: UUID(), fileName: "nba-2025-invoice-224468.pdf", fileSize: "24 kb"),
    ]

    @State private var toAddress: String = "john@johnstown.com"
    @State private var subject: String = "looking for a basketball scholarship"
    @State private var bodyText: String = """
    Dear Whatsyourface,

    Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.

    Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.

    Best,
    Rok
    """

    var body: some View {
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
                onSend: {}
            )
        }
        .frame(height: 640)
    }
}

/// Demo wrapper that renders the side-by-side layout from the Figma mocks
/// — a placeholder home column on the leading side and either the email
/// editor or the invoice preview on the trailing side, toggleable via a
/// segmented picker. `HomePageView` requires far too much setup
/// (`HomeStore`, `HomeFeedStore`, etc.) to make a realistic full demo
/// worthwhile here, so the leading column is intentionally a minimal
/// placeholder. The intent is to show the visual relationship between
/// the two columns, not to exercise the real home page.
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
        .init(id: UUID(), fileName: "nba-2025-invoice-224468.pdf", fileSize: "24 kb"),
    ]

    @State private var variant: Variant = .email
    @State private var toAddress: String = "john@johnstown.com"
    @State private var subject: String = "looking for a basketball scholarship"
    @State private var bodyText: String = """
    Dear Whatsyourface,

    Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.

    Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.

    Best,
    Rok
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
                    onSend: {}
                )
            }
        case .document:
            HomeDetailPanel(
                icon: .file,
                title: "Porsche-preview-2.4S.png",
                onGoToThread: {},
                onDismiss: {}
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
                    userMessage: "Can you send $5,000 to NBA Merchandising for the annual subscription?",
                    assistantResponse: "Sure — I've drafted the transfer on Stripe. Before I release it, I need your permission to authorize the payment.",
                    confirmation: ToolConfirmationData(
                        requestId: "preview-nba-txn",
                        toolName: "stripe_transfer",
                        input: [
                            "amount_usd": .init(5000),
                            "recipient": .init("NBA Merchandising")
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
        case "recapPill": HomeGallerySection(filter: "recapPill")
        case "homeAuthCard": HomeGallerySection(filter: "homeAuthCard")
        case "homePermissionCard": HomeGallerySection(filter: "homePermissionCard")
        case "homeAssistantCard": HomeGallerySection(filter: "homeAssistantCard")
        case "homeReplyCard": HomeGallerySection(filter: "homeReplyCard")
        case "homeEmailPreviewCard": HomeGallerySection(filter: "homeEmailPreviewCard")
        case "homeImageCard": HomeGallerySection(filter: "homeImageCard")
        case "homeFileCard": HomeGallerySection(filter: "homeFileCard")
        case "homeUpdatesListCard": HomeGallerySection(filter: "homeUpdatesListCard")
        case "homeFeedGroupHeader": HomeGallerySection(filter: "homeFeedGroupHeader")
        case "homeRecapRow": HomeGallerySection(filter: "homeRecapRow")
        case "homeDetailPanel": HomeGallerySection(filter: "homeDetailPanel")
        case "homeEmailEditor": HomeGallerySection(filter: "homeEmailEditor")
        case "homeDocumentPreview": HomeGallerySection(filter: "homeDocumentPreview")
        case "homePermissionChatPreview": HomeGallerySection(filter: "homePermissionChatPreview")
        case "homeSplitLayout": HomeGallerySection(filter: "homeSplitLayout")
        case "homeSuggestionPillBar": HomeGallerySection(filter: "homeSuggestionPillBar")
        case "homeFeedFilterBar": HomeGallerySection(filter: "homeFeedFilterBar")
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
