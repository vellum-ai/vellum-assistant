#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Main container for the Things tab — shows a segmented picker switching
/// between My Apps, Shared Apps, and Documents.
struct ThingsView: View {
    @ObservedObject var directoryStore: DirectoryStore

    private enum Segment: String, CaseIterable {
        case myApps = "My Apps"
        case shared = "Shared"
        case documents = "Documents"
    }

    @State private var selectedSegment: Segment = .myApps

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Section", selection: $selectedSegment) {
                    ForEach(Segment.allCases, id: \.self) { segment in
                        Text(segment.rawValue).tag(segment)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
                .accessibilityLabel("Things section picker")

                switch selectedSegment {
                case .myApps:
                    AppsGridView(directoryStore: directoryStore)
                case .shared:
                    SharedAppsListView(directoryStore: directoryStore)
                case .documents:
                    DocumentsListView(directoryStore: directoryStore)
                }
            }
            .navigationTitle("Things")
            .onAppear {
                directoryStore.fetchApps()
                directoryStore.fetchSharedApps()
                directoryStore.fetchDocuments()
            }
        }
    }
}

#Preview {
    ThingsView(directoryStore: DirectoryStore(daemonClient: DaemonClient(config: .default)))
}
#endif
