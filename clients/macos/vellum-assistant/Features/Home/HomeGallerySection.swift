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
                            timestamp: Date().addingTimeInterval(-2 * 60 * 60),
                            status: .new,
                            onDismiss: {},
                            onTap: {}
                        )

                        HomeRecapRow(
                            icon: .bell,
                            iconForeground: VColor.feedDigestStrong,
                            iconBackground: VColor.feedDigestWeak,
                            title: "There's also 4 low priority updates if you want to have a look.",
                            timestamp: Date().addingTimeInterval(-30 * 60),
                            status: .seen,
                            onDismiss: {},
                            onTap: {}
                        )

                        HomeRecapRow(
                            icon: .bell,
                            iconForeground: VColor.feedDigestStrong,
                            iconBackground: VColor.feedDigestWeak,
                            title: "Urgent: your flight to SFO boards in 35 minutes.",
                            timestamp: Date(),
                            status: .new,
                            isUrgent: true,
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
                    description: "Reusable white right-side panel container with a standardized header (icon + title + \"Go to Convo\" action + overflow menu + close)."
                )

                VStack(spacing: VSpacing.lg) {
                    HomeDetailPanel(
                        icon: .file,
                        title: "Panel title",
                        onGoToConvo: {},
                        onMarkReadUnread: {},
                        onDismissItem: {},
                        onClose: {}
                    ) {
                        Text("Detail content goes here.")
                            .padding(VSpacing.lg)
                    }
                    .frame(height: 260)

                    HomeDetailPanel(
                        icon: .bell,
                        title: "Assistant-initiated",
                        onGoToConvo: {},
                        onMarkReadUnread: {},
                        isRead: true,
                        onDismissItem: {},
                        onClose: {},
                        showsPersonaAvatar: true
                    ) {
                        Text("Persona avatar replaces the category chip when the row originated from the assistant.")
                            .padding(VSpacing.lg)
                    }
                    .frame(height: 260)
                }
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
                    description: "Home feed header with a leading avatar and a trailing New Chat pill CTA."
                )

                VCard(background: VColor.surfaceBase) {
                    HomeGreetingHeader(
                        onStartNewChat: {},
                        greeting: nil,
                        name: "Example Assistant"
                    ) {
                        if let image = NSImage(systemSymbolName: "person.circle.fill", accessibilityDescription: nil) {
                            VAvatarImage(image: image, size: 56)
                        } else {
                            Circle()
                                .fill(VColor.surfaceActive)
                                .frame(width: 56, height: 56)
                        }
                    }
                }
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
        case "homeDetailPanel": HomeGallerySection(filter: "homeDetailPanel")
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
