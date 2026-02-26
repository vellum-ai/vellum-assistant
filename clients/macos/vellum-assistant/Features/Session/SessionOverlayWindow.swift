import AppKit
import Combine

@MainActor
final class SessionOverlayWindow {
    private var panel: NSPanel?
    private let session: ComputerUseSession
    private var cancellables = Set<AnyCancellable>()

    // Retained views for in-place updates
    private var headerIcon: NSImageView?
    private var headerLabel: NSTextField?
    private var taskLabel: NSTextField?
    private var stateContainer: NSView?
    private var guidanceContainer: NSView?
    private var controlsContainer: NSView?
    private var spinner: NSProgressIndicator?
    private var guidanceField: NSTextField?

    private let panelWidth: CGFloat = 440
    private let padding: CGFloat = 16
    private let sectionSpacing: CGFloat = 14 // VSpacing.md + VSpacing.xxs

    init(session: ComputerUseSession) {
        self.session = session
    }

    func show() {
        let contentView = SessionOverlayBackgroundView()
        contentView.wantsLayer = true

        let stack = buildContent()
        stack.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: padding),
            stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: padding),
            stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -padding),
            stack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -padding),
        ])

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: 160),
            styleMask: [.titled, .nonactivatingPanel, .utilityWindow, .hudWindow],
            backing: .buffered,
            defer: false
        )

        panel.contentView = contentView
        panel.level = .floating
        panel.isMovableByWindowBackground = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.alphaValue = 0.9
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary]

        positionPanel(panel)
        panel.orderFront(nil)
        self.panel = panel

        // Observe state, undoCount, and autoApproveTools changes
        session.$state
            .sink { [weak self] state in
                self?.updateState(state)
            }
            .store(in: &cancellables)

        session.$undoCount
            .sink { [weak self] _ in
                self?.updateControls()
            }
            .store(in: &cancellables)

        session.$autoApproveTools
            .sink { [weak self] _ in
                self?.updateControls()
            }
            .store(in: &cancellables)
    }

    func close() {
        cancellables.removeAll()
        spinner?.stopAnimation(nil)
        panel?.close()
        panel = nil
    }

    // MARK: - Build Content

    private func buildContent() -> NSView {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = sectionSpacing

        // Header
        let header = buildHeader()
        stack.addArrangedSubview(header)

        // Task text
        let task = makeLabel(session.task, font: .systemFont(ofSize: 11), color: .secondaryLabelColor, maxLines: 2)
        self.taskLabel = task
        stack.addArrangedSubview(task)

        // Divider
        let divider = makeDivider()
        stack.addArrangedSubview(divider)
        divider.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        // State content (wrapped in scroll view)
        let stateView = buildStateContent(session.state)
        self.stateContainer = stateView

        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false

        let clipView = NSClipView()
        clipView.drawsBackground = false
        scrollView.contentView = clipView
        scrollView.documentView = stateView
        stateView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stateView.topAnchor.constraint(equalTo: clipView.topAnchor),
            stateView.leadingAnchor.constraint(equalTo: clipView.leadingAnchor),
            stateView.trailingAnchor.constraint(equalTo: clipView.trailingAnchor),
        ])
        scrollView.heightAnchor.constraint(lessThanOrEqualToConstant: 400).isActive = true

        stack.addArrangedSubview(scrollView)
        scrollView.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        // Guidance input
        let guidance = buildGuidanceInput()
        self.guidanceContainer = guidance
        stack.addArrangedSubview(guidance)
        guidance.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        updateGuidanceVisibility()

        // Controls
        let controls = buildControls()
        self.controlsContainer = controls
        stack.addArrangedSubview(controls)

        // Set width
        stack.widthAnchor.constraint(equalToConstant: panelWidth - padding * 2).isActive = true

        return stack
    }

    private func buildHeader() -> NSView {
        let hstack = NSStackView()
        hstack.orientation = .horizontal
        hstack.spacing = 8

        let icon = NSImageView()
        if let img = NSImage(systemSymbolName: "cursorarrow.click.2", accessibilityDescription: nil) {
            icon.image = img
            icon.contentTintColor = .systemBlue
        }
        icon.widthAnchor.constraint(equalToConstant: 16).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 16).isActive = true
        self.headerIcon = icon

        let label = makeLabel("Vellum is working...", font: .boldSystemFont(ofSize: 13), color: .labelColor, maxLines: 1)
        self.headerLabel = label

        hstack.addArrangedSubview(icon)
        hstack.addArrangedSubview(label)

        return hstack
    }

    // MARK: - State Content

    private func buildStateContent(_ state: SessionState) -> NSView {
        switch state {
        case .idle:
            return makeLabel("Initializing...", font: .systemFont(ofSize: 11), color: .secondaryLabelColor)

        case .thinking(let step, let maxSteps):
            return buildThinkingView(step: step, maxSteps: maxSteps)

        case .running(let step, let maxSteps, let lastAction, let reasoning):
            return buildRunningView(step: step, maxSteps: maxSteps, lastAction: lastAction, reasoning: reasoning)

        case .paused(let step, let maxSteps):
            return makeLabel("Paused at step \(step)/\(maxSteps)", font: .systemFont(ofSize: 11), color: .systemOrange)

        case .awaitingConfirmation(let reason):
            return buildConfirmationView(reason: reason)

        case .completed(let summary, let steps):
            return buildCompletedView(summary: summary, steps: steps)

        case .responded(let answer, _):
            return buildRespondedView(answer: answer)

        case .failed(let reason):
            return buildFailedView(reason: reason)

        case .cancelled:
            return makeLabel("Cancelled", font: .boldSystemFont(ofSize: 11), color: .systemOrange)
        }
    }

    private func buildThinkingView(step: Int, maxSteps: Int) -> NSView {
        let vstack = NSStackView()
        vstack.orientation = .vertical
        vstack.alignment = .leading
        vstack.spacing = 4

        let stepLabel = makeLabel("Step \(step) of \(maxSteps)", font: .systemFont(ofSize: 11), color: .secondaryLabelColor)
        vstack.addArrangedSubview(stepLabel)

        let hstack = NSStackView()
        hstack.orientation = .horizontal
        hstack.spacing = 6

        let s = NSProgressIndicator()
        s.style = .spinning
        s.controlSize = .small
        s.isIndeterminate = true
        s.startAnimation(nil)
        s.widthAnchor.constraint(equalToConstant: 16).isActive = true
        s.heightAnchor.constraint(equalToConstant: 16).isActive = true
        self.spinner = s

        let thinkingLabel = makeLabel("Thinking...", font: .systemFont(ofSize: 11), color: .secondaryLabelColor)

        hstack.addArrangedSubview(s)
        hstack.addArrangedSubview(thinkingLabel)
        vstack.addArrangedSubview(hstack)

        return vstack
    }

    private func buildRunningView(step: Int, maxSteps: Int, lastAction: String, reasoning: String) -> NSView {
        let vstack = NSStackView()
        vstack.orientation = .vertical
        vstack.alignment = .leading
        vstack.spacing = 4

        let stepLabel = makeLabel("Step \(step) of \(maxSteps)", font: .systemFont(ofSize: 11), color: .secondaryLabelColor)
        vstack.addArrangedSubview(stepLabel)

        if !reasoning.isEmpty {
            let reasoningRow = NSStackView()
            reasoningRow.orientation = .horizontal
            reasoningRow.spacing = 0

            // Blue bar
            let bar = NSView()
            bar.wantsLayer = true
            bar.layer?.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.4).cgColor
            bar.translatesAutoresizingMaskIntoConstraints = false
            bar.widthAnchor.constraint(equalToConstant: 3).isActive = true

            let reasoningLabel = makeLabel(reasoning, font: .systemFont(ofSize: 13), color: .labelColor)
            reasoningLabel.translatesAutoresizingMaskIntoConstraints = false

            let wrapper = NSView()
            wrapper.addSubview(bar)
            wrapper.addSubview(reasoningLabel)
            bar.translatesAutoresizingMaskIntoConstraints = false
            reasoningLabel.translatesAutoresizingMaskIntoConstraints = false

            NSLayoutConstraint.activate([
                bar.leadingAnchor.constraint(equalTo: wrapper.leadingAnchor),
                bar.topAnchor.constraint(equalTo: wrapper.topAnchor),
                bar.bottomAnchor.constraint(equalTo: wrapper.bottomAnchor),
                bar.widthAnchor.constraint(equalToConstant: 3),

                reasoningLabel.leadingAnchor.constraint(equalTo: bar.trailingAnchor, constant: 6),
                reasoningLabel.trailingAnchor.constraint(equalTo: wrapper.trailingAnchor),
                reasoningLabel.topAnchor.constraint(equalTo: wrapper.topAnchor),
                reasoningLabel.bottomAnchor.constraint(equalTo: wrapper.bottomAnchor),
            ])

            vstack.addArrangedSubview(wrapper)
            wrapper.widthAnchor.constraint(equalTo: vstack.widthAnchor).isActive = true
        }

        let actionLabel = makeLabel(lastAction, font: .systemFont(ofSize: 13), color: .secondaryLabelColor)
        vstack.addArrangedSubview(actionLabel)

        return vstack
    }

    private func buildConfirmationView(reason: String) -> NSView {
        let vstack = NSStackView()
        vstack.orientation = .vertical
        vstack.alignment = .leading
        vstack.spacing = 8

        // Warning header
        let warningRow = NSStackView()
        warningRow.orientation = .horizontal
        warningRow.spacing = 4

        let warningIcon = NSImageView()
        if let img = NSImage(systemSymbolName: "exclamationmark.triangle.fill", accessibilityDescription: nil) {
            warningIcon.image = img
            warningIcon.contentTintColor = .systemYellow
        }
        warningIcon.widthAnchor.constraint(equalToConstant: 14).isActive = true
        warningIcon.heightAnchor.constraint(equalToConstant: 14).isActive = true

        let warningLabel = makeLabel("Confirmation needed", font: .boldSystemFont(ofSize: 11), color: .labelColor)

        warningRow.addArrangedSubview(warningIcon)
        warningRow.addArrangedSubview(warningLabel)
        vstack.addArrangedSubview(warningRow)

        // Reason
        let reasonLabel = makeLabel(reason, font: .systemFont(ofSize: 11), color: .secondaryLabelColor)
        vstack.addArrangedSubview(reasonLabel)

        // Buttons
        let buttonRow = NSStackView()
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 8

        let allowBtn = makeButton("Allow", action: #selector(SessionOverlayButtonTarget.allowClicked))
        allowBtn.bezelStyle = .rounded
        allowBtn.bezelColor = .systemBlue
        allowBtn.contentTintColor = .white

        let blockBtn = makeButton("Block", action: #selector(SessionOverlayButtonTarget.blockClicked))
        blockBtn.bezelStyle = .rounded

        let stopBtn = makeButton("Stop", action: #selector(SessionOverlayButtonTarget.stopClicked))
        stopBtn.bezelStyle = .rounded
        stopBtn.contentTintColor = .systemRed

        buttonRow.addArrangedSubview(allowBtn)
        buttonRow.addArrangedSubview(blockBtn)
        buttonRow.addArrangedSubview(stopBtn)
        vstack.addArrangedSubview(buttonRow)

        return vstack
    }

    private func buildCompletedView(summary: String, steps: Int) -> NSView {
        let hstack = NSStackView()
        hstack.orientation = .horizontal
        hstack.alignment = .top
        hstack.spacing = 6

        let icon = NSImageView()
        if let img = NSImage(systemSymbolName: "checkmark.circle.fill", accessibilityDescription: nil) {
            icon.image = img
            icon.contentTintColor = .systemGreen
        }
        icon.widthAnchor.constraint(equalToConstant: 14).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 14).isActive = true

        let textStack = NSStackView()
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 2

        let doneLabel = makeLabel("Done in \(steps) steps", font: .boldSystemFont(ofSize: 11), color: .labelColor)
        let summaryLabel = makeLabel(summary, font: .systemFont(ofSize: 11), color: .secondaryLabelColor, maxLines: 2)

        textStack.addArrangedSubview(doneLabel)
        textStack.addArrangedSubview(summaryLabel)

        hstack.addArrangedSubview(icon)
        hstack.addArrangedSubview(textStack)

        return hstack
    }

    private func buildRespondedView(answer: String) -> NSView {
        let vstack = NSStackView()
        vstack.orientation = .vertical
        vstack.alignment = .leading
        vstack.spacing = 6

        // Response header
        let headerRow = NSStackView()
        headerRow.orientation = .horizontal
        headerRow.spacing = 6

        let icon = NSImageView()
        if let img = NSImage(systemSymbolName: "text.bubble.fill", accessibilityDescription: nil) {
            icon.image = img
            icon.contentTintColor = .systemBlue
        }
        icon.widthAnchor.constraint(equalToConstant: 14).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 14).isActive = true

        let responseLabel = makeLabel("Response", font: .boldSystemFont(ofSize: 11), color: .labelColor)

        headerRow.addArrangedSubview(icon)
        headerRow.addArrangedSubview(responseLabel)
        vstack.addArrangedSubview(headerRow)

        // Scrollable text
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false

        let textView = NSTextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.drawsBackground = false
        textView.font = NSFont.systemFont(ofSize: 11)
        textView.textColor = .labelColor
        textView.string = answer
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)

        scrollView.documentView = textView
        scrollView.heightAnchor.constraint(lessThanOrEqualToConstant: 200).isActive = true

        vstack.addArrangedSubview(scrollView)

        // Make the responded view wider
        vstack.widthAnchor.constraint(equalToConstant: 380 - padding * 2).isActive = true

        return vstack
    }

    private func buildFailedView(reason: String) -> NSView {
        let hstack = NSStackView()
        hstack.orientation = .horizontal
        hstack.alignment = .top
        hstack.spacing = 6

        let icon = NSImageView()
        if let img = NSImage(systemSymbolName: "xmark.circle.fill", accessibilityDescription: nil) {
            icon.image = img
            icon.contentTintColor = .systemRed
        }
        icon.widthAnchor.constraint(equalToConstant: 14).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 14).isActive = true

        let reasonLabel = makeLabel(reason, font: .systemFont(ofSize: 11), color: .secondaryLabelColor, maxLines: 3)

        hstack.addArrangedSubview(icon)
        hstack.addArrangedSubview(reasonLabel)

        return hstack
    }

    // MARK: - Controls

    private func buildControls() -> NSView {
        let container = NSView()
        let controls = controlsForState(session.state)
        controls.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(controls)
        NSLayoutConstraint.activate([
            controls.topAnchor.constraint(equalTo: container.topAnchor),
            controls.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            controls.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            controls.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        return container
    }

    private func controlsForState(_ state: SessionState) -> NSView {
        switch state {
        case .running, .thinking:
            let hstack = NSStackView()
            hstack.orientation = .horizontal
            hstack.spacing = 8

            let undoBtn = makeUndoButton()
            let autoApproveBtn = makeAutoApproveButton()
            let spacer = NSView()
            spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
            let pauseBtn = makeButton("Pause", action: #selector(SessionOverlayButtonTarget.pauseClicked))
            pauseBtn.bezelStyle = .rounded
            let stopBtn = makeButton("Stop", action: #selector(SessionOverlayButtonTarget.stopClicked))
            stopBtn.bezelStyle = .rounded
            stopBtn.contentTintColor = .systemRed

            hstack.addArrangedSubview(undoBtn)
            hstack.addArrangedSubview(autoApproveBtn)
            hstack.addArrangedSubview(spacer)
            hstack.addArrangedSubview(pauseBtn)
            hstack.addArrangedSubview(stopBtn)

            return hstack

        case .paused:
            let hstack = NSStackView()
            hstack.orientation = .horizontal
            hstack.spacing = 8

            let undoBtn = makeUndoButton()
            let spacer = NSView()
            spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
            let resumeBtn = makeButton("Resume", action: #selector(SessionOverlayButtonTarget.resumeClicked))
            resumeBtn.bezelStyle = .rounded
            resumeBtn.bezelColor = .systemBlue
            resumeBtn.contentTintColor = .white
            let stopBtn = makeButton("Stop", action: #selector(SessionOverlayButtonTarget.stopClicked))
            stopBtn.bezelStyle = .rounded
            stopBtn.contentTintColor = .systemRed

            hstack.addArrangedSubview(undoBtn)
            hstack.addArrangedSubview(spacer)
            hstack.addArrangedSubview(resumeBtn)
            hstack.addArrangedSubview(stopBtn)

            return hstack

        case .completed, .failed, .cancelled, .responded:
            let hstack = NSStackView()
            hstack.orientation = .horizontal
            hstack.spacing = 8

            let undoBtn = makeUndoButton()
            let spacer = NSView()
            spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

            hstack.addArrangedSubview(undoBtn)
            hstack.addArrangedSubview(spacer)

            return hstack

        default:
            return NSView()
        }
    }

    // MARK: - Guidance Input

    private func buildGuidanceInput() -> NSView {
        let container = NSView()

        let hstack = NSStackView()
        hstack.orientation = .horizontal
        hstack.spacing = 8
        hstack.translatesAutoresizingMaskIntoConstraints = false

        let field = NSTextField()
        field.placeholderString = "Steer the agent..."
        field.font = NSFont.systemFont(ofSize: 13)
        field.textColor = .labelColor
        field.backgroundColor = NSColor(white: 0.2, alpha: 1.0)
        field.isBordered = false
        field.isBezeled = true
        field.bezelStyle = .roundedBezel
        field.cell?.wraps = false
        field.cell?.isScrollable = true
        field.target = buttonTarget
        field.action = #selector(SessionOverlayButtonTarget.sendGuidanceClicked)
        self.guidanceField = field

        let sendBtn = NSButton()
        if let img = NSImage(systemSymbolName: "arrow.up.circle.fill", accessibilityDescription: "Send guidance") {
            sendBtn.image = img
        }
        sendBtn.isBordered = false
        sendBtn.target = buttonTarget
        sendBtn.action = #selector(SessionOverlayButtonTarget.sendGuidanceClicked)
        sendBtn.widthAnchor.constraint(equalToConstant: 20).isActive = true
        sendBtn.heightAnchor.constraint(equalToConstant: 20).isActive = true

        hstack.addArrangedSubview(field)
        hstack.addArrangedSubview(sendBtn)

        container.addSubview(hstack)
        NSLayoutConstraint.activate([
            hstack.topAnchor.constraint(equalTo: container.topAnchor),
            hstack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            hstack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            hstack.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])

        return container
    }

    func sendGuidance() {
        guard let field = guidanceField else { return }
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        session.pendingUserGuidance = text
        field.stringValue = ""
    }

    private func updateGuidanceVisibility() {
        let showGuidance: Bool
        switch session.state {
        case .running, .thinking, .paused:
            showGuidance = true
        default:
            showGuidance = false
        }
        guidanceContainer?.isHidden = !showGuidance
    }

    // MARK: - Update

    private func updateState(_ state: SessionState) {
        guard let stateContainer else { return }

        // Stop any running spinner
        spinner?.stopAnimation(nil)
        spinner = nil

        // Replace state content inside the scroll view's clip view
        let newState = buildStateContent(state)
        if let scrollDocView = stateContainer.superview {
            stateContainer.removeFromSuperview()
            scrollDocView.addSubview(newState)
            newState.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                newState.topAnchor.constraint(equalTo: scrollDocView.topAnchor),
                newState.leadingAnchor.constraint(equalTo: scrollDocView.leadingAnchor),
                newState.trailingAnchor.constraint(equalTo: scrollDocView.trailingAnchor),
            ])
            self.stateContainer = newState
        }

        // Update guidance visibility
        updateGuidanceVisibility()

        // Replace controls
        updateControls()

        // Resize window to fit
        resizeToFit()
    }

    private func updateControls() {
        guard let controlsContainer else { return }

        // Remove old controls
        for sub in controlsContainer.subviews {
            sub.removeFromSuperview()
        }

        let controls = controlsForState(session.state)
        controls.translatesAutoresizingMaskIntoConstraints = false
        controlsContainer.addSubview(controls)
        NSLayoutConstraint.activate([
            controls.topAnchor.constraint(equalTo: controlsContainer.topAnchor),
            controls.leadingAnchor.constraint(equalTo: controlsContainer.leadingAnchor),
            controls.trailingAnchor.constraint(equalTo: controlsContainer.trailingAnchor),
            controls.bottomAnchor.constraint(equalTo: controlsContainer.bottomAnchor),
        ])

        resizeToFit()
    }

    private func resizeToFit() {
        guard let panel, let contentView = panel.contentView else { return }

        let fittingSize = contentView.fittingSize
        let newSize = NSSize(
            width: max(panelWidth, fittingSize.width),
            height: fittingSize.height
        )
        panel.setContentSize(newSize)
        positionPanel(panel)
    }

    private func positionPanel(_ panel: NSPanel) {
        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let panelFrame = panel.frame
            let x = screenFrame.maxX - panelFrame.width - 20
            let y = screenFrame.minY + 20
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }
    }

    // MARK: - View Factories

    private func makeLabel(_ text: String, font: NSFont, color: NSColor, maxLines: Int = 0) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = font
        field.textColor = color
        field.lineBreakMode = .byTruncatingTail
        field.maximumNumberOfLines = maxLines
        field.cell?.wraps = maxLines != 1
        field.cell?.truncatesLastVisibleLine = true
        return field
    }

    private func makeDivider() -> NSView {
        let divider = NSBox()
        divider.boxType = .separator
        return divider
    }

    private func makeButton(_ title: String, action: Selector) -> NSButton {
        let btn = NSButton(title: title, target: buttonTarget, action: action)
        btn.controlSize = .small
        btn.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
        return btn
    }

    private func makeUndoButton() -> NSButton {
        let title = session.undoCount > 0 ? "Undo (\(session.undoCount))" : "Undo"
        let btn = NSButton(title: title, target: buttonTarget, action: #selector(SessionOverlayButtonTarget.undoClicked))
        btn.controlSize = .small
        btn.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
        btn.bezelStyle = .rounded
        if let img = NSImage(systemSymbolName: "arrow.uturn.backward", accessibilityDescription: nil) {
            btn.image = img
            btn.imagePosition = .imageLeading
        }
        return btn
    }

    private func makeAutoApproveButton() -> NSButton {
        let btn = NSButton(
            title: "Auto-approve",
            target: buttonTarget,
            action: #selector(SessionOverlayButtonTarget.autoApproveClicked)
        )
        btn.controlSize = .small
        btn.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
        btn.bezelStyle = .rounded
        let symbolName = session.autoApproveTools ? "checkmark.shield.fill" : "shield"
        if let img = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil) {
            btn.image = img
            btn.imagePosition = .imageLeading
        }
        if session.autoApproveTools {
            btn.contentTintColor = .systemGreen
        }
        return btn
    }

    // MARK: - Button Target

    private lazy var buttonTarget: SessionOverlayButtonTarget = {
        let target = SessionOverlayButtonTarget(session: session)
        target.overlayWindow = self
        return target
    }()
}

// MARK: - Button Target (NSObject for selectors)

private class SessionOverlayButtonTarget: NSObject {
    private let session: ComputerUseSession
    weak var overlayWindow: SessionOverlayWindow?

    init(session: ComputerUseSession) {
        self.session = session
    }

    @MainActor @objc func allowClicked() { session.approveConfirmation() }
    @MainActor @objc func blockClicked() { session.rejectConfirmation() }
    @MainActor @objc func stopClicked() { session.cancel() }
    @MainActor @objc func pauseClicked() { session.pause() }
    @MainActor @objc func resumeClicked() { session.resume() }
    @MainActor @objc func undoClicked() { session.undo() }
    @MainActor @objc func autoApproveClicked() { session.autoApproveTools.toggle() }
    @MainActor @objc func sendGuidanceClicked() { overlayWindow?.sendGuidance() }
}

// MARK: - Background View

private class SessionOverlayBackgroundView: NSView {
    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.backgroundColor = NSColor(white: 0.15, alpha: 0.95).cgColor
        layer?.cornerRadius = 12
        layer?.borderWidth = 1
        layer?.borderColor = NSColor(white: 0.25, alpha: 1.0).cgColor
    }
}
