import SwiftUI
import VellumAssistantShared

/// Standalone search overlay for ChatView. Creates its own observation scope
/// so that reading `viewModel.messages` (needed for match filtering) only
/// invalidates this view — not the parent ChatView outer body.
struct ChatSearchOverlay: View {
    var viewModel: ChatViewModel
    @Binding var isSearchActive: Bool
    @Binding var anchorMessageId: UUID?
    @Binding var searchQuery: String

    @State private var currentMatchIndex = 0

    struct SearchMatch {
        let messageId: UUID
        let range: NSRange
    }

    private var searchMatches: [SearchMatch] {
        guard isSearchActive, !searchQuery.isEmpty else { return [] }
        return Self.searchMatches(in: viewModel.messages, query: searchQuery)
    }

    var body: some View {
        Group {
            if isSearchActive {
                ChatSearchBar(
                    searchText: $searchQuery,
                    matchCount: searchMatches.count,
                    currentMatchIndex: currentMatchIndex,
                    onPrevious: { navigateMatch(delta: -1) },
                    onNext: { navigateMatch(delta: 1) },
                    onDismiss: { isSearchActive = false }
                )
                .padding(.trailing, VSpacing.xl)
                .padding(.top, VSpacing.sm)
                .transition(.opacity.combined(with: .move(edge: .top)))
                .layoutHangSignpost("chat.searchOverlay")
            }
        }
        .onChange(of: searchQuery) {
            currentMatchIndex = 0
            scrollToCurrentMatch()
        }
        .onChange(of: searchMatches.count) {
            let count = searchMatches.count
            if currentMatchIndex >= count {
                currentMatchIndex = max(count - 1, 0)
            }
        }
        .onChange(of: isSearchActive) { _, active in
            if !active {
                searchQuery = ""
                currentMatchIndex = 0
            }
        }
    }

    private func navigateMatch(delta: Int) {
        let matches = searchMatches
        guard !matches.isEmpty else { return }
        currentMatchIndex = (currentMatchIndex + delta + matches.count) % matches.count
        scrollToCurrentMatch()
    }

    private func scrollToCurrentMatch() {
        let matches = searchMatches
        guard !matches.isEmpty, currentMatchIndex < matches.count else { return }
        anchorMessageId = matches[currentMatchIndex].messageId
    }

    static func searchMatches(in messages: [ChatMessage], query: String) -> [SearchMatch] {
        guard !query.isEmpty else { return [] }
        return messages.flatMap { message in
            occurrenceRanges(in: message.text, query: query).map { range in
                SearchMatch(messageId: message.id, range: range)
            }
        }
    }

    static func occurrenceRanges(in text: String, query: String) -> [NSRange] {
        guard !query.isEmpty else { return [] }
        let nsText = text as NSString
        var ranges: [NSRange] = []
        var start = 0

        while start < nsText.length {
            let found = nsText.range(
                of: query,
                options: [.caseInsensitive, .diacriticInsensitive],
                range: NSRange(location: start, length: nsText.length - start)
            )
            guard found.location != NSNotFound, found.length > 0 else { break }
            ranges.append(found)
            start = found.location + found.length
        }

        return ranges
    }
}
