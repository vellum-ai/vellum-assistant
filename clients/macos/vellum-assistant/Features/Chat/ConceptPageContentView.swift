import SwiftUI
import VellumAssistantShared

/// Lazily fetches and renders the raw markdown body of a memory v2 concept
/// page identified by `slug`. Used both inside the message-inspector
/// activation-log row (no `onDismiss` — the disclosure-group chrome handles
/// collapse) and as the right-hand detail pane of `MemoriesV2Panel` (with
/// `onDismiss` to render a close affordance in the header).
///
/// Body content is rendered as monospaced text — no markdown renderer.
struct ConceptPageContentView: View {
    let slug: String
    /// When non-nil, a header with a close button is rendered above the
    /// content. When nil, the view shows only the page-content label and
    /// content (used inside the activation-log disclosure where the
    /// disclosure chrome already provides collapse).
    let onDismiss: (() -> Void)?

    @State private var state: LoadState = .idle

    enum LoadState: Equatable {
        case idle
        case loading
        case missing
        case loaded(String)
    }

    init(slug: String, onDismiss: (() -> Void)? = nil) {
        self.slug = slug
        self.onDismiss = onDismiss
    }

    /// Whether this view is rendered as a standalone detail pane (with its
    /// own chrome — header, padding, fill-height) versus inline inside a
    /// disclosure-group body that already provides chrome.
    private var isDetailPane: Bool { onDismiss != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            header
            content
            if isDetailPane {
                Spacer(minLength: 0)
            }
        }
        .padding(isDetailPane ? VSpacing.lg : 0)
        .background(isDetailPane ? VColor.surfaceBase : Color.clear)
        .task(id: slug) {
            // SwiftUI fires `.task` when this view first renders inside the
            // disclosed body (inspector) or when the panel selection changes.
            // The load runs once per slug; cached `state` is reused across
            // re-renders of the same slug.
            guard state == .idle else { return }
            state = .loading
            let client = LLMContextClient()
            if let rendered = await client.fetchConceptPage(slug: slug) {
                state = .loaded(rendered)
            } else {
                state = .missing
            }
        }
    }

    @ViewBuilder
    private var header: some View {
        if let onDismiss {
            HStack(alignment: .center, spacing: VSpacing.sm) {
                Text(slug)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)

                Spacer(minLength: VSpacing.sm)

                VButton(
                    label: "Close",
                    iconOnly: VIcon.x.rawValue,
                    style: .ghost,
                    tintColor: VColor.contentTertiary,
                    action: onDismiss
                )
                .accessibilityLabel("Close concept page")
            }
            .padding(.bottom, VSpacing.xs)
        } else {
            Text("page content")
                .font(VFont.labelSmall)
                .foregroundStyle(VColor.contentSecondary)
                .padding(.top, VSpacing.sm)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .idle, .loading:
            HStack(spacing: VSpacing.xs) {
                ProgressView().controlSize(.small)
                Text("Loading…")
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
            }
        case .missing:
            Text("Page not found on disk — slug may reference a stale Qdrant entry.")
                .font(VFont.labelSmall)
                .foregroundStyle(VColor.contentTertiary)
        case .loaded(let text):
            if isDetailPane {
                ScrollView { loadedTextBlock(text) }
                    .scrollContentBackground(.hidden)
            } else {
                loadedTextBlock(text)
            }
        }
    }

    private func loadedTextBlock(_ text: String) -> some View {
        HStack(spacing: 0) {
            Text(text)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(VColor.contentDefault)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .padding(VSpacing.sm)
        .background(isDetailPane ? VColor.surfaceOverlay : VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }
}
