import SwiftUI
import VellumAssistantShared

struct ConversationArtifactsButton: View {
    let artifacts: [ConversationArtifact]
    let onOpenApp: (ConversationArtifact) -> Void
    let onOpenDocument: (ConversationArtifact) -> Void

    @State private var isPopoverPresented = false
    @State private var hoveredArtifactId: String?

    private var label: String {
        let count = artifacts.count
        return count == 1 ? "1 asset" : "\(count) assets"
    }

    var body: some View {
        if artifacts.isEmpty {
            EmptyView()
        } else {
            Button {
                isPopoverPresented.toggle()
            } label: {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.layers, size: 10)
                    Text(label)
                        .font(VFont.bodySmallDefault)
                }
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
                .background(VColor.surfaceOverlay)
                .clipShape(Capsule())
                .overlay(Capsule().stroke(VColor.borderBase, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .accessibilityLabel("Conversation assets, \(artifacts.count) items")
            .popover(isPresented: $isPopoverPresented, arrowEdge: .bottom) {
                popoverContent
            }
        }
    }

    @ViewBuilder
    private var popoverContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Assets")
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
