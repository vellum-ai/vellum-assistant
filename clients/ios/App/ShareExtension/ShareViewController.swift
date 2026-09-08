import UIKit
import UniformTypeIdentifiers

/// Root of the share extension: a navigation controller so the sheet
/// shows a title and Cancel.
@objc(ShareNavigationController)
final class ShareNavigationController: UINavigationController {
    override func viewDidLoad() {
        super.viewDidLoad()
        viewControllers = [ShareViewController()]
    }
}

/// Share Sheet target: collect the shared items, pick a destination, write
/// the payload to the App Group inbox, and open the host app.
///
/// The picker is the same recent-chats cache the Shortcuts "Send Message
/// to Chat" action uses. "New conversation" is always first. An optional
/// note field is prepended to any shared text or URL so the assistant
/// sees both the instruction and the actual link or file.
@objc(ShareViewController)
final class ShareViewController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    private let noteView = UITextView()
    private let tableView = UITableView(frame: .zero, style: .insetGrouped)
    private let sendButton = UIButton(type: .system)

    private var chats: [RecentChat] = []
    private var selectedRow = 0
    private var collectedText: [String] = []
    private var collectedFiles: [(filename: String, mimeType: String, data: Data)] = []
    private var collectionFinished = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        chats = RecentChatsStore.load()
        configureNavigation()
        configureNote()
        configureTable()
        configureSend()
        layout()
        collectAttachments()
    }

    private func configureNavigation() {
        title = "Vellum"
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .cancel,
            target: self,
            action: #selector(cancel)
        )
    }

    private func configureNote() {
        noteView.font = .preferredFont(forTextStyle: .body)
        noteView.adjustsFontForContentSizeCategory = true
        noteView.backgroundColor = .secondarySystemGroupedBackground
        noteView.layer.cornerRadius = 10
        noteView.textContainerInset = UIEdgeInsets(top: 10, left: 8, bottom: 10, right: 8)
        noteView.accessibilityLabel = "Add a note"
        let placeholder = UILabel()
        placeholder.text = "Add a note"
        placeholder.font = noteView.font
        placeholder.textColor = .placeholderText
        placeholder.tag = 1
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        noteView.addSubview(placeholder)
        NSLayoutConstraint.activate([
            placeholder.leadingAnchor.constraint(equalTo: noteView.leadingAnchor, constant: 13),
            placeholder.topAnchor.constraint(equalTo: noteView.topAnchor, constant: 10),
        ])
        noteView.delegate = NotePlaceholderDelegate.shared
        NotePlaceholderDelegate.shared.refresh(noteView)
    }

    private func configureTable() {
        tableView.dataSource = self
        tableView.delegate = self
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "row")
        tableView.backgroundColor = .clear
    }

    private func configureSend() {
        var config = UIButton.Configuration.filled()
        config.cornerStyle = .large
        config.title = "Send"
        sendButton.configuration = config
        sendButton.addTarget(self, action: #selector(send), for: .touchUpInside)
        sendButton.isEnabled = false
    }

    private func layout() {
        let stack = UIStackView(arrangedSubviews: [noteView, tableView, sendButton])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
            noteView.heightAnchor.constraint(equalToConstant: 88),
            sendButton.heightAnchor.constraint(equalToConstant: 50),
        ])
    }

    private var destination: ShareInboxDestination {
        if selectedRow == 0 {
            return .newConversation
        }
        let index = selectedRow - 1
        guard chats.indices.contains(index) else {
            return .newConversation
        }
        return .thread(id: chats[index].id)
    }

    private func combinedText() -> String? {
        let note = noteView.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var parts: [String] = []
        if !note.isEmpty {
            parts.append(note)
        }
        parts.append(contentsOf: collectedText)
        if parts.isEmpty {
            return nil
        }
        return parts.joined(separator: "\n\n")
    }

    private func refreshSendEnabled() {
        sendButton.isEnabled = collectionFinished
            && (combinedText() != nil || !collectedFiles.isEmpty)
    }

    @objc private func cancel() {
        extensionContext?.cancelRequest(
            withError: NSError(domain: "ShareExtension", code: 0)
        )
    }

    @objc private func send() {
        sendButton.isEnabled = false
        let text = combinedText()
        let files = collectedFiles
        let dest = destination
        DispatchQueue.global(qos: .userInitiated).async {
            let id = ShareInbox.write(destination: dest, text: text, files: files)
            DispatchQueue.main.async {
                guard let id else {
                    self.finish()
                    return
                }
                ShareInbox.postReadyNotification()
                self.openHost(inboxId: id)
                self.finish()
            }
        }
    }

    private func openHost(inboxId: String) {
        guard let url = ShareDeepLink(inboxId: inboxId).url() else {
            return
        }
        var responder: UIResponder? = self
        let selector = sel_registerName("openURL:")
        while let current = responder {
            if current.responds(to: selector) {
                current.perform(selector, with: url)
                break
            }
            responder = current.next
        }
        extensionContext?.open(url, completionHandler: nil)
    }

    private func finish() {
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }

    // MARK: - Table

    func numberOfSections(in tableView: UITableView) -> Int {
        1
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        1 + chats.count
    }

    func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        "Send to"
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath)
        var content = cell.defaultContentConfiguration()
        if indexPath.row == 0 {
            content.text = "New conversation"
        } else {
            content.text = chats[indexPath.row - 1].title
        }
        cell.contentConfiguration = content
        cell.accessoryType = indexPath.row == selectedRow ? .checkmark : .none
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        selectedRow = indexPath.row
        tableView.reloadData()
    }

    // MARK: - Item collection

    private func collectAttachments() {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
        guard !providers.isEmpty else {
            collectionFinished = true
            refreshSendEnabled()
            return
        }
        let group = DispatchGroup()
        for provider in providers {
            group.enter()
            load(provider) {
                group.leave()
            }
        }
        group.notify(queue: .main) {
            self.collectionFinished = true
            self.refreshSendEnabled()
        }
    }

    private func load(_ provider: NSItemProvider, completion: @escaping () -> Void) {
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                if let data, !data.isEmpty {
                    let name = provider.suggestedName ?? "image.jpg"
                    let mime = Self.mimeType(for: name, fallback: "image/jpeg")
                    self.appendFile(filename: name, mimeType: mime, data: data)
                }
                completion()
            }
            return
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) { item, _ in
                if let url = Self.url(from: item) {
                    self.copyFile(at: url)
                }
                completion()
            }
            return
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.url.identifier) { item, _ in
                if let url = Self.url(from: item), url.scheme != "file" {
                    self.appendText(url.absoluteString)
                }
                completion()
            }
            return
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { item, _ in
                if let text = item as? String {
                    self.appendText(text)
                }
                completion()
            }
            return
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
            provider.loadDataRepresentation(forTypeIdentifier: UTType.data.identifier) { data, _ in
                if let data, !data.isEmpty {
                    let name = provider.suggestedName ?? "attachment"
                    self.appendFile(
                        filename: name,
                        mimeType: Self.mimeType(for: name, fallback: "application/octet-stream"),
                        data: data
                    )
                }
                completion()
            }
            return
        }
        completion()
    }

    private func copyFile(at url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer {
            if scoped {
                url.stopAccessingSecurityScopedResource()
            }
        }
        guard let data = try? Data(contentsOf: url), !data.isEmpty else {
            return
        }
        appendFile(
            filename: url.lastPathComponent,
            mimeType: Self.mimeType(for: url.lastPathComponent, fallback: "application/octet-stream"),
            data: data
        )
    }

    private func appendText(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return
        }
        onMain {
            if !self.collectedText.contains(trimmed) {
                self.collectedText.append(trimmed)
            }
        }
    }

    private func appendFile(filename: String, mimeType: String, data: Data) {
        onMain {
            if self.collectedFiles.count >= ShareInbox.maxFiles {
                return
            }
            if data.count > ShareInbox.maxFileBytes {
                return
            }
            self.collectedFiles.append((filename: filename, mimeType: mimeType, data: data))
        }
    }

    private func onMain(_ work: () -> Void) {
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.sync(execute: work)
        }
    }

    private static func url(from item: NSSecureCoding?) -> URL? {
        if let url = item as? URL {
            return url
        }
        if let data = item as? Data {
            return URL(dataRepresentation: data, relativeTo: nil)
        }
        if let string = item as? String {
            return URL(string: string)
        }
        return nil
    }

    private static func mimeType(for filename: String, fallback: String) -> String {
        let ext = (filename as NSString).pathExtension
        guard !ext.isEmpty,
              let type = UTType(filenameExtension: ext),
              let mime = type.preferredMIMEType
        else {
            return fallback
        }
        return mime
    }
}

/// Keeps the note field's placeholder visible only while the text is empty.
private final class NotePlaceholderDelegate: NSObject, UITextViewDelegate {
    static let shared = NotePlaceholderDelegate()

    func textViewDidChange(_ textView: UITextView) {
        refresh(textView)
    }

    func refresh(_ textView: UITextView) {
        textView.viewWithTag(1)?.isHidden = !textView.text.isEmpty
    }
}
