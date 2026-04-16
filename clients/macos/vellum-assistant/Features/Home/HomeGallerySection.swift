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

            // MARK: - RecapPillView

            if filter == nil || filter == "recapPill" {
                GallerySectionHeader(
                    title: "RecapPillView",
                    description: "Inline interactive pill for recap text with optional priority icon."
                )

                VCard {
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

                VCard {
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
                            showDismiss: true,
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

                VCard {
                    HomePermissionCard(
                        title: "Permission Required",
                        threadName: "Project Setup",
                        toolActionTitle: "Run shell command",
                        toolActionDescription: "npm install --save-dev typescript",
                        showDismiss: false,
                        onAuthorise: {},
                        onDeny: {},
                        onDismiss: nil
                    )
                }
            }

            // MARK: - HomeAssistantCard

            if filter == nil || filter == "homeAssistantCard" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }

                GallerySectionHeader(
                    title: "HomeAssistantCard",
                    description: "Assistant-to-assistant message card with Authorise/Deny actions."
                )

                VCard {
                    HomeAssistantCard(
                        title: "Research Assistant wants to share findings",
                        threadName: "Weekly Report",
                        onAuthorise: {},
                        onDeny: {}
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

                VCard {
                    HomeReplyCard(
                        title: "What time should I schedule the meeting?",
                        threadName: "Calendar Management",
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

                VCard {
                    HomeEmailPreviewCard(
                        title: "Draft email ready",
                        threadName: "Client Follow-up",
                        toAddress: "client@example.com",
                        subject: "Project Update - Q4 Milestones",
                        bodyText: "Hi team, I wanted to share a quick update on our Q4 milestones...",
                        onSend: {},
                        onRework: {}
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
                    description: "Image preview card with Save and Open in Finder actions."
                )

                VCard {
                    HomeImageCard(
                        title: "Generated chart preview",
                        threadName: "Data Analysis",
                        image: nil,
                        onSave: {},
                        onOpenInFinder: {}
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

                VCard {
                    HomeFileCard(
                        title: "File saved",
                        threadName: "Document Processing",
                        fileName: "quarterly-report.pdf",
                        fileSize: "1.2 MB"
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

                VCard {
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
#endif
