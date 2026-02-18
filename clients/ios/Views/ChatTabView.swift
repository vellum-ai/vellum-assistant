#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct ChatTabView: View {
    @StateObject private var viewModel: ChatViewModel

    init(daemonClient: any DaemonClientProtocol) {
        _viewModel = StateObject(wrappedValue: ChatViewModel(daemonClient: daemonClient))
    }

    var body: some View {
        ChatContentView(viewModel: viewModel)
            .navigationTitle("Chat")
            .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview {
    let daemonClient: any DaemonClientProtocol = DaemonClient(config: .default)
    return NavigationStack {
        ChatTabView(daemonClient: daemonClient)
    }
}
#endif
