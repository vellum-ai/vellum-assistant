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
