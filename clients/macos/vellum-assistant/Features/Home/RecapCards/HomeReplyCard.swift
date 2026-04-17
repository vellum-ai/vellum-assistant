import SwiftUI
import VellumAssistantShared

/// Recap card that presents a reply prompt with an inline message
/// composer. Used on the Home page when the assistant wants the user
/// to respond to a question in a thread.
struct HomeReplyCard: View {
    let title: String
    let threadName: String?
    let onDismiss: (() -> Void)?
    let onSend: (String) -> Void

    @State private var inputText: String = ""

    init(
        title: String,
        threadName: String? = nil,
        onDismiss: (() -> Void)? = nil,
        onSend: @escaping (String) -> Void
    ) {
        self.title = title
        self.threadName = threadName
        self.onDismiss = onDismiss
        self.onSend = onSend
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            composerBar
                .padding(.top, VSpacing.md)
        }
        .glassCard()
        .recapCardMaxWidth(fill: true)
    }

    // MARK: - Header

    private var header: some View {
        HomeRecapCardHeader(
            icon: .messageCircle,
            title: title,
            subtitle: threadName,
            titleLineLimit: nil,
            onDismiss: onDismiss
        )
    }

    // MARK: - Inline Composer

    private var composerBar: some View {
        HStack(spacing: VSpacing.lg) {
            composerInput
            composerIcons
        }
        .padding(.leading, VSpacing.md)
        .padding(.trailing, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .frame(minHeight: 40)
        .background(
            Capsule(style: .continuous)
                .fill(VColor.surfaceLift)
        )
    }

    private var composerInput: some View {
        ZStack(alignment: .leading) {
            if inputText.isEmpty {
                Text("What would you like to do?")
                    .font(VFont.bodyLargeDefault)
                    .foregroundStyle(VColor.contentDisabled)
            }

            TextField("", text: $inputText)
                .textFieldStyle(.plain)
                .font(VFont.bodyLargeDefault)
                .foregroundStyle(VColor.contentEmphasized)
                .accessibilityLabel(Text("Reply message"))
                .onSubmit {
                    if !inputText.isEmpty {
                        onSend(inputText)
                        inputText = ""
                    }
                }
        }
    }

    private var composerIcons: some View {
        HStack(spacing: VSpacing.lg) {
            VIconView(.paperclip, size: 14)
                .foregroundStyle(VColor.contentTertiary)

            VIconView(.mic, size: 14)
                .foregroundStyle(VColor.contentTertiary)

            sendButton
        }
    }

    private var sendButton: some View {
        Button {
            guard !inputText.isEmpty else { return }
            onSend(inputText)
            inputText = ""
        } label: {
            ZStack {
                Circle()
                    .fill(VColor.contentDefault)
                    .frame(width: 20, height: 20)

                VIconView(.audioWaveform, size: 14)
                    .foregroundStyle(VColor.surfaceLift)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Send")
        .pointerCursor()
    }
}
