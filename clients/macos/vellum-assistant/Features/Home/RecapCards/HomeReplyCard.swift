import SwiftUI
import VellumAssistantShared

/// Recap card that presents a reply prompt with an inline message
/// composer. Used on the Home page when the assistant wants the user
/// to respond to a question in a thread.
struct HomeReplyCard: View {
    let title: String
    let threadName: String?
    let showDismiss: Bool
    let onDismiss: (() -> Void)?
    let onSend: (String) -> Void

    @State private var inputText: String = ""

    init(
        title: String,
        threadName: String? = nil,
        showDismiss: Bool = false,
        onDismiss: (() -> Void)? = nil,
        onSend: @escaping (String) -> Void
    ) {
        self.title = title
        self.threadName = threadName
        self.showDismiss = showDismiss
        self.onDismiss = onDismiss
        self.onSend = onSend
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            composerBar
                .padding(.top, VSpacing.md)
        }
        .padding(VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous)
                .fill(VColor.surfaceLift.opacity(0.1))
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous))
        .vShadow(VShadow.md)
    }

    // MARK: - Header

    private var header: some View {
        HomeRecapCardHeader(
            icon: .messageCircle,
            title: title,
            subtitle: threadName,
            titleLineLimit: nil,
            showDismiss: showDismiss,
            onDismiss: onDismiss
        )
    }

    // MARK: - Inline Composer

    private var composerBar: some View {
        HStack(spacing: VSpacing.sm) {
            composerInput
            composerIcons
        }
        .padding(.leading, VSpacing.md)
        .padding(.trailing, VSpacing.sm)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.window, style: .continuous)
                .fill(VColor.auxWhite)
        )
        .shadow(
            color: VColor.auxBlack.opacity(0.05),
            radius: 2,
            x: 0,
            y: 2
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
                    }
                }
        }
    }

    private var composerIcons: some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(.paperclip, size: 20)
                .foregroundStyle(VColor.contentTertiary)

            VIconView(.mic, size: 20)
                .foregroundStyle(VColor.contentTertiary)

            VIconView(.audioWaveform, size: 32)
                .foregroundStyle(VColor.contentDefault)
        }
    }
}
