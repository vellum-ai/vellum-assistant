import SwiftUI

struct TextResponseView: View {
    @ObservedObject var session: TextSession

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md + VSpacing.xxs) {
            // Header
            HStack(spacing: VSpacing.sm) {
                Image(systemName: "text.bubble.fill")
                    .foregroundStyle(.blue)
                Text(UserDefaults.standard.string(forKey: "assistantName") ?? "vellum-assistant")
                    .font(VFont.headline)
                    .lineLimit(1)
            }

            // Task text
            Text(session.task)
                .font(VFont.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)

            Divider()

            // State-dependent content
            stateContent

            // Controls
            controlButtons
        }
        .padding(14)
        .frame(width: 400, alignment: .leading)
    }

    @ViewBuilder
    private var stateContent: some View {
        switch session.state {
        case .idle:
            Text("Initializing...")
                .foregroundStyle(.secondary)

        case .thinking:
            HStack(spacing: 6) {
                ProgressView()
                    .controlSize(.small)
                Text("Thinking...")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

        case .streaming(let text):
            ScrollViewReader { proxy in
                ScrollView {
                    Text(text)
                        .font(.system(.caption, design: .default))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .id("streamingText")
                }
                .frame(maxHeight: 300)
                .onChange(of: text) {
                    proxy.scrollTo("streamingText", anchor: .bottom)
                }
            }

        case .completed(let text):
            ScrollView {
                Text(text)
                    .font(.system(.caption, design: .default))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .frame(maxHeight: 300)

        case .failed(let reason):
            HStack(spacing: 6) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.red)
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }

        case .cancelled:
            Text("Cancelled")
                .font(.caption.bold())
                .foregroundStyle(.orange)
        }
    }

    @ViewBuilder
    private var controlButtons: some View {
        switch session.state {
        case .thinking, .streaming:
            HStack {
                Spacer()
                Button("Stop") {
                    session.cancel()
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .controlSize(.small)
            }

        case .completed(let text):
            HStack {
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(text, forType: .string)
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                Spacer()
            }

        default:
            EmptyView()
        }
    }
}
