import SwiftUI
import VellumAssistantShared

/// Compact button that shows the count of conversation artifacts (apps and documents).
/// Tapping it opens a popover listing each artifact with appropriate actions.
struct ConversationArtifactsButton: View {
    let artifacts: [ConversationArtifact]
    let onOpenApp: (ConversationArtifact) -> Void
    let onOpenDocument: (ConversationArtifact) -> Void

    @State private var isPopoverPresented = false
    @State private var hoveredArtifactId: String?

    var body: some View {
        if artifacts.isEmpty {
            EmptyView()
        } else {
            Button {
                isPopoverPresented.toggle()
            } label: {
                HStack(spacing: VSpacing.xxs) {
                    VIconView(.layers, size: 14)
                    Text("\(artifacts.count)")
                        .font(VFont.labelSmall)
                }
                .foregroundStyle(VColor.contentSecondary)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xs)
                .background(VColor.surfaceOverlay)
                .cornerRadius(VRadius.md)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.borderBase, lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Conversation artifacts, \(artifacts.count) items")
            .popover(isPresented: $isPopoverPresented, arrowEdge: .bottom) {
                popoverContent
            }
        }
    }

    @ViewBuilder
    private var popoverContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Artifacts")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
                .padding(.horizontal, VSpacing.md)
                .padding(.top, VSpacing.md)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(artifacts) { artifact in
                        artifactRow(artifact)
                    }
                }
            }
            .padding(.bottom, VSpacing.sm)
        }
        .frame(width: 240)
        .frame(maxHeight: 300)
        .background(VColor.surfaceOverlay)
        .cornerRadius(VRadius.lg)
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
        .vShadow(VShadow.sm)
    }

    @ViewBuilder
    private func artifactRow(_ artifact: ConversationArtifact) -> some View {
        let isHovered = hoveredArtifactId == artifact.id
        Button {
            isPopoverPresented = false
            switch artifact.type {
            case .app:
                onOpenApp(artifact)
            case .document:
                onOpenDocument(artifact)
            }
        } label: {
            HStack(spacing: VSpacing.sm) {
                VIconView(artifact.type == .app ? .appWindow : .fileText, size: 14)
                    .foregroundStyle(VColor.contentSecondary)
                Text(artifact.title)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(isHovered ? VColor.surfaceBase : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            hoveredArtifactId = hovering ? artifact.id : nil
        }
        .accessibilityLabel(artifact.type == .app
            ? "Open app: \(artifact.title)"
            : "Open document: \(artifact.title)")
    }
}
