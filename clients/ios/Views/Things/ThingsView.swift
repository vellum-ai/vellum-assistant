#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Main container for the Things tab — shows a segmented picker switching
/// between My Apps, Shared Apps, and Documents.
struct ThingsView: View {
    @ObservedObject var directoryStore: DirectoryStore
    @AppStorage(UserDefaultsKeys.developerModeEnabled) private var developerModeEnabled: Bool = false

    private enum Segment: String, CaseIterable {
        case myApps = "My Apps"
        case shared = "Shared"
        case documents = "Documents"
    }

    @State private var selectedSegment: Segment = .myApps

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Developer-mode diagnostic banner for fetch errors.
                if developerModeEnabled, let fetchError = directoryStore.lastFetchError {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.triangleAlert, size: 12)
                            Text("Library fetch failed")
                                .font(VFont.labelDefault)
                        }
                        .foregroundStyle(VColor.systemNegativeStrong)
                        Text(fetchError)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(VColor.systemNegativeStrong)
                            .textSelection(.enabled)
                        Text(GatewayHTTPClient.connectionDiagnostics())
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(VColor.contentSecondary)
                            .textSelection(.enabled)
                    }
                    .padding()
                    .background(Color(.secondarySystemBackground))
                    .cornerRadius(8)
                    .padding(.horizontal)
                    .padding(.top, VSpacing.xs)
                }

                Picker("Section", selection: $selectedSegment) {
                    ForEach(Segment.allCases, id: \.self) { segment in
                        Text(segment.rawValue).tag(segment)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
                .accessibilityLabel("Library section picker")

                switch selectedSegment {
                case .myApps:
                    AppsGridView(directoryStore: directoryStore)
                case .shared:
                    SharedAppsListView(directoryStore: directoryStore)
                case .documents:
                    DocumentsListView(directoryStore: directoryStore)
                }
            }
            .navigationTitle("Library")
            .onAppear {
                directoryStore.fetchApps()
                directoryStore.fetchSharedApps()
                directoryStore.fetchDocuments()
            }
        }
    }
}
#endif
