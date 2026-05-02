import SwiftUI
import VellumAssistantShared

/// Standalone search overlay for ChatView. Creates its own observation scope
/// so that reading `viewModel.messages` (needed for match filtering) only
/// invalidates this view — not the parent ChatView outer body.
struct ChatSearchOverlay: View {
    var viewModel: ChatViewModel
    @Binding var isSearchActive: Bool
    @Binding var anchorMessageId: UUID?

    @State private var searchText = ""
    @State private var currentMatchIndex = 0

    private var searchMatches: [UUID] {
        guard isSearchActive, !searchText.isEmpty else { return [] }
        let query = searchText.lowercased()
        return viewModel.messages.filter { $0.text.lowercased().contains(query) }.map(\.id)
    }

    var body: some View {
        Group {
            if isSearchActive {
                ChatSearchBar(
                    searchText: $searchText,
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
        .onChange(of: searchText) {
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
                searchText = ""
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
        anchorMessageId = matches[currentMatchIndex]
    }
}
