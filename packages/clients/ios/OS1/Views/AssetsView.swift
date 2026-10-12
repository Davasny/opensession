import SwiftUI
#if os(iOS)
import UIKit
import WebKit
#endif

#if os(iOS)
/// The session's scratch assets: the file list, one level deeper than the
/// conversation.
///
/// Rows push the file itself, so the way back out is the chevron and the edge
/// swipe — the same way back as everywhere else in the stack. It brings no
/// `NavigationStack` of its own: it is always pushed into one that exists
/// already (the session's, or the workspace sheet's).
struct AssetsListView: View {
    let sessionId: String

    @State private var files: [OS1API.SessionAsset] = []
    @State private var loading = true
    @State private var loadFailed = false
    /// The file being read, pushed one level deeper.
    @State private var openFile: OS1API.SessionAsset?

    var body: some View {
        Group {
            if loading && files.isEmpty {
                loadingPlaceholder
            } else if loadFailed && files.isEmpty {
                failedPlaceholder
            } else if files.isEmpty {
                emptyPlaceholder
            } else {
                fileList
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(OS1VisualStyle.background)
        .navigationTitle("Assets")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await load() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
            }
        }
        .navigationDestination(item: $openFile) { asset in
            AssetDetailView(
                sessionId: sessionId,
                asset: asset,
                onDeleted: { files.removeAll { $0.id == asset.id } }
            )
        }
        .task(id: sessionId) { await load() }
    }

    // MARK: - The list

    private var fileList: some View {
        List {
            Section {
                ForEach(files) { asset in
                    Button {
                        openFile = asset
                    } label: {
                        AssetRow(asset: asset)
                    }
                    .buttonStyle(.plain)
                }
            } footer: {
                Text("Scratch files this session's agent wrote. They live "
                     + "outside the repository and are never committed.")
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(OS1VisualStyle.background)
        .refreshable { await load() }
    }

    // MARK: - Placeholders

    private var loadingPlaceholder: some View {
        ProgressView()
            .controlSize(.large)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyPlaceholder: some View {
        ListPlaceholder(
            symbol: "folder",
            title: "No assets yet",
            message: "Artifacts this session writes — reports, charts, sample "
                + "data — show up here."
        ) {
            EmptyView()
        }
    }

    private var failedPlaceholder: some View {
        ListPlaceholder(
            symbol: "exclamationmark.triangle",
            title: "Couldn't load assets",
            message: "The server didn't answer for this session's files."
        ) {
            Button("Try again") { Task { await load() } }
                .buttonStyle(PlaceholderActionStyle())
        }
    }

    // MARK: - Loading

    private func load() async {
        loading = true
        loadFailed = false
        let loaded = (try? await OS1API.assets(sessionId: sessionId)) ?? []
        guard !Task.isCancelled else { return }
        // Newest first: the file an agent just wrote is the one you came for.
        files = loaded.sorted { $0.mtime > $1.mtime }
        loadFailed = files.isEmpty && loaded.isEmpty
        loading = false
    }
}

/// One asset on its own, pushed from the list or hosted in a cover over the
/// conversation when a chat row's chip pointed at it.
///
/// It takes the path rather than the file's listing row: a chip in the
/// transcript knows what was written, not how big it ended up, and waiting
/// for a directory listing to render a file you already named would be a
/// spinner for nothing.
struct AssetDetailView: View {
    let sessionId: String
    let asset: OS1API.SessionAsset
    var showsDone = false
    var onOpenAssets: (() -> Void)?
    var onDeleted: (() -> Void)?

    @Environment(\.dismiss) private var dismiss

    init(
        sessionId: String,
        asset: OS1API.SessionAsset,
        showsDone: Bool = false,
        onOpenAssets: (() -> Void)? = nil,
        onDeleted: (() -> Void)? = nil
    ) {
        self.sessionId = sessionId
        self.asset = asset
        self.showsDone = showsDone
        self.onOpenAssets = onOpenAssets
        self.onDeleted = onDeleted
    }

    init(sessionId: String, path: String) {
        self.init(
            sessionId: sessionId,
            asset: OS1API.SessionAsset(path: path, size: 0, mtime: "")
        )
    }

    var body: some View {
        AssetPreview(sessionId: sessionId, asset: asset)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(OS1VisualStyle.background)
            .navigationTitle(asset.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if showsDone {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Done") { dismiss() }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    AssetActionsMenu(
                        sessionId: sessionId,
                        asset: asset,
                        onOpenAssets: onOpenAssets,
                        onDeleted: onDeleted
                    )
                }
            }
    }
}

/// The file operations stay in one predictable place on pushed details and
/// covers. The cover adds "Show in Assets"; inside the Assets view it would
/// only point back to the place already on screen, so it is omitted.
struct AssetActionsMenu: View {
    let sessionId: String
    let asset: OS1API.SessionAsset
    var onOpenAssets: (() -> Void)?
    var onDeleted: (() -> Void)?
    var onDarkBackground = false

    @Environment(\.dismiss) private var dismiss
    @State private var confirmingDelete = false
    @State private var preparingShare = false
    @State private var sharedFile: SharedAssetFile?
    @State private var sharedDirectory: URL?
    @State private var errorMessage: String?

    var body: some View {
        Menu {
            if let onOpenAssets {
                Button {
                    onOpenAssets()
                    dismiss()
                } label: {
                    Label("Show in Assets", systemImage: "folder")
                }
                Divider()
            }
            Button {
                prepareShare()
            } label: {
                Label("Share file", systemImage: "square.and.arrow.up")
            }
            .disabled(preparingShare)
            Divider()
            Button(role: .destructive) {
                confirmingDelete = true
            } label: {
                Label("Delete", systemImage: "trash")
            }
        } label: {
            Group {
                if preparingShare {
                    ProgressView()
                } else {
                    Image(systemName: "ellipsis")
                }
            }
            .frame(width: 36, height: 36)
            .foregroundStyle(onDarkBackground ? .white : OS1VisualStyle.text)
            .background(onDarkBackground ? .black.opacity(0.55) : .clear, in: Circle())
        }
        .accessibilityLabel("Asset actions")
        .confirmationDialog(
            "Delete \(asset.name)?",
            isPresented: $confirmingDelete,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) { deleteAsset() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the file from this session's Assets folder.")
        }
        .sheet(item: $sharedFile, onDismiss: removeSharedFile) { file in
            AssetActivityView(items: [file.url])
        }
        .alert(
            "Couldn't complete that action",
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "Please try again.")
        }
    }

    private func prepareShare() {
        guard !preparingShare else { return }
        preparingShare = true
        Task {
            defer { preparingShare = false }
            var temporaryDirectory: URL?
            do {
                let data = try await OS1API.assetData(
                    sessionId: sessionId,
                    path: asset.path
                )
                let directory = FileManager.default.temporaryDirectory
                    .appendingPathComponent("os1-shared-assets", isDirectory: true)
                    .appendingPathComponent(UUID().uuidString, isDirectory: true)
                temporaryDirectory = directory
                try FileManager.default.createDirectory(
                    at: directory,
                    withIntermediateDirectories: true
                )
                let url = directory.appendingPathComponent(asset.name)
                try data.write(to: url, options: .atomic)
                sharedDirectory = directory
                sharedFile = SharedAssetFile(url: url)
            } catch {
                if let temporaryDirectory {
                    try? FileManager.default.removeItem(at: temporaryDirectory)
                }
                errorMessage = error.localizedDescription
            }
        }
    }

    private func deleteAsset() {
        Task {
            do {
                try await OS1API.deleteAsset(sessionId: sessionId, path: asset.path)
                onDeleted?()
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func removeSharedFile() {
        if let sharedDirectory {
            try? FileManager.default.removeItem(at: sharedDirectory)
        }
        sharedDirectory = nil
        sharedFile = nil
    }
}

private struct SharedAssetFile: Identifiable {
    let url: URL
    var id: URL { url }
}

private struct AssetActivityView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(
        _ uiViewController: UIActivityViewController,
        context: Context
    ) {}
}

/// One file in the list: what it's called, where it sits, how big and how old.
private struct AssetRow: View {
    let asset: OS1API.SessionAsset

    /// The folders above the file, when it isn't at the top level.
    private var folder: String? {
        let parts = asset.path.split(separator: "/")
        guard parts.count > 1 else { return nil }
        return parts.dropLast().joined(separator: "/")
    }

    var body: some View {
        HStack(spacing: 11) {
            Image(systemName: AssetKind.of(asset).symbol)
                .symbolRenderingMode(.hierarchical)
                .font(.system(size: 15))
                .foregroundStyle(OS1VisualStyle.textDim)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(asset.name)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(OS1VisualStyle.text)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            // The row pushes; the chevron is the promise that it does, and
            // that the way back is the one you already know.
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.textFaint)
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
    }

    private var subtitle: String {
        var parts: [String] = []
        if let folder { parts.append(folder) }
        parts.append(
            ByteCountFormatter.string(
                fromByteCount: Int64(asset.size),
                countStyle: .file
            )
        )
        if let modified = asset.modified {
            parts.append(modified.formatted(.relative(presentation: .named)))
        }
        return parts.joined(separator: " · ")
    }
}

#endif

/// How one asset is rendered. WebKit handles most of it — and MUST, for
/// anything whose relative references have to resolve — but markdown would
/// arrive as raw source and code as an unstyled wall, and the app already
/// renders both properly.
///
/// Outside the iOS-only section: the transcript's asset chips draw its glyph
/// and the transcript is shared with the Mac app, where the chip names the
/// same file even though nothing there can push a viewer for it.
enum AssetKind {
    case web
    case markdown
    case text
    case opaque

    static func of(_ asset: OS1API.SessionAsset) -> AssetKind {
        switch asset.ext {
        case "html", "htm", "svg", "pdf",
             "png", "jpg", "jpeg", "gif", "webp", "ico",
             "mp4", "webm", "mov", "mp3", "wav":
            return .web
        case "md", "markdown":
            return .markdown
        case "txt", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "json",
             "csv", "tsv", "xml", "yaml", "yml", "log", "py", "sh", "sql",
             "swift", "rs", "go", "rb", "toml", "ini", "env":
            return .text
        default:
            return .opaque
        }
    }

    var symbol: String {
        switch self {
        case .web: "safari"
        case .markdown: "doc.richtext"
        case .text: "curlybraces"
        case .opaque: "doc"
        }
    }
}

/// The assets whose contents are the useful label: pictures and recordings.
/// Workspace Info shows these as frames; pages, documents, audio, and data keep
/// their filename rows because their names and descriptions carry the meaning.
enum AssetVisualKind: Equatable {
    case image
    case video

    static func of(_ asset: OS1API.SessionAsset) -> AssetVisualKind? {
        switch asset.ext {
        case "png", "jpg", "jpeg", "gif", "webp", "ico": .image
        case "mp4", "webm", "mov": .video
        default: nil
        }
    }
}

#if os(iOS)
/// One asset, rendered.
private struct AssetPreview: View {
    let sessionId: String
    let asset: OS1API.SessionAsset

    @State private var text: String?
    @State private var textFailed = false
    @State private var webPhase = AssetWebPhase.loading

    /// Enough of a text file to read on a phone; a generated log can be huge
    /// and the point of the preview is to see what the agent produced.
    private static let maxTextCharacters = 200_000

    var body: some View {
        Group {
            switch AssetKind.of(asset) {
            case .web:
                if let url = OS1API.assetURL(sessionId: sessionId, path: asset.path) {
                    AssetWebView(url: url, sessionId: sessionId, phase: $webPhase)
                        .ignoresSafeArea(.container, edges: .bottom)
                        // A page takes a few seconds on a phone; blank until
                        // then read as a file that would not open.
                        .overlay {
                            switch webPhase {
                            case .loading:
                                ProgressView()
                                    .controlSize(.large)
                                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                                    .background(OS1VisualStyle.background)
                            case .failed(let reason):
                                ListPlaceholder(
                                    symbol: "exclamationmark.triangle",
                                    title: "Couldn't open this file",
                                    message: reason
                                ) {
                                    EmptyView()
                                }
                                .background(OS1VisualStyle.background)
                            case .loaded:
                                EmptyView()
                            }
                        }
                } else {
                    opaquePlaceholder
                }
            case .markdown:
                // A file is read as a page, not a chat message.
                loadedText { MarkdownDocumentView($0) }
            case .text:
                textScroll { body in
                    if let language = SyntaxHighlighting.language(forPath: asset.path) {
                        ScrollView(.horizontal) {
                            SyntaxHighlightedCodeText(
                                text: body,
                                language: language,
                                fallbackColor: OS1VisualStyle.text
                            )
                            .fixedSize(horizontal: true, vertical: false)
                        }
                    } else {
                        Text(body)
                            .font(.caption.monospaced())
                            .foregroundStyle(OS1VisualStyle.text)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            case .opaque:
                opaquePlaceholder
            }
        }
        .task(id: asset.path) { await loadTextIfNeeded() }
    }

    private func textScroll<Content: View>(
        @ViewBuilder _ content: @escaping (String) -> Content
    ) -> some View {
        loadedText { text in
            ScrollView {
                content(text)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
            }
        }
    }

    /// The file's text once it has loaded, or the loading and failure states.
    @ViewBuilder
    private func loadedText<Content: View>(
        @ViewBuilder _ content: @escaping (String) -> Content
    ) -> some View {
        if let text {
            content(text)
        } else if textFailed {
            ListPlaceholder(
                symbol: "exclamationmark.triangle",
                title: "Couldn't read this file",
                message: asset.path
            ) {
                EmptyView()
            }
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var opaquePlaceholder: some View {
        ListPlaceholder(
            symbol: "doc",
            title: asset.name,
            message: ByteCountFormatter.string(
                fromByteCount: Int64(asset.size),
                countStyle: .file
            ) + " · no preview for this kind of file"
        ) {
            EmptyView()
        }
    }

    private func loadTextIfNeeded() async {
        let kind = AssetKind.of(asset)
        guard kind == .markdown || kind == .text else { return }
        text = nil
        textFailed = false
        guard let data = try? await OS1API.assetData(
            sessionId: sessionId,
            path: asset.path
        ) else {
            textFailed = true
            return
        }
        guard !Task.isCancelled else { return }
        text = String(
            String(decoding: data, as: UTF8.self).prefix(Self.maxTextCharacters)
        )
    }
}

/// An asset in a web view, loaded from the route that serves it.
///
/// Not a native image or PDF view: an HTML asset's relative references
/// (./style.css, ./data.json) only resolve when the page is loaded from the
/// raw route itself, and that route is authenticated. WebKit won't carry the
/// app's `Authorization` header on subresource loads, so the session token
/// rides in as the same `opensession_auth` cookie the web client uses —
/// scoped to THIS session's assets path, so a page an agent wrote can reach
/// its own siblings and nothing else on the API.
enum AssetWebPhase: Equatable {
    case loading
    case loaded
    case failed(String)
}

private struct AssetWebView: UIViewRepresentable {
    let url: URL
    let sessionId: String
    @Binding var phase: AssetWebPhase

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Nothing an asset leaves behind should outlive the tab; the cookie is
        // re-seeded on every load anyway.
        configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = true
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.navigationDelegate = context.coordinator
        context.coordinator.phase = $phase
        context.coordinator.load(url, in: webView, sessionId: sessionId)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.phase = $phase
        guard context.coordinator.loaded != url else { return }
        context.coordinator.load(url, in: webView, sessionId: sessionId)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        private(set) var loaded: URL?
        var phase: Binding<AssetWebPhase>?

        private func set(_ next: AssetWebPhase) {
            if phase?.wrappedValue != next { phase?.wrappedValue = next }
        }

        /// The raw route answers an error as a page of its own; say so
        /// instead of showing it as the file.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse
        ) async -> WKNavigationResponsePolicy {
            if navigationResponse.isForMainFrame,
               let http = navigationResponse.response as? HTTPURLResponse,
               http.statusCode >= 400 {
                set(.failed(http.statusCode == 404
                    ? "The file is no longer in this session's assets."
                    : "The server answered \(http.statusCode)."))
                return .cancel
            }
            return .allow
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            set(.loaded)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            fail(error)
        }

        private func fail(_ error: Error) {
            // A navigation the policy above cancelled has already said why.
            if case .failed = phase?.wrappedValue { return }
            if (error as NSError).code == NSURLErrorCancelled { return }
            set(.failed(error.localizedDescription))
        }

        /// Seeding has to FINISH before the navigation starts: a cookie set
        /// alongside the load loses the race and the asset comes back a 401.
        func load(_ url: URL, in webView: WKWebView, sessionId: String) {
            loaded = url
            set(.loading)
            let token = ServerConfig.shared.token
            guard !token.isEmpty, let cookie = Self.authCookie(
                token: token,
                url: url,
                sessionId: sessionId
            ) else {
                // A server running without the auth gate needs no cookie.
                webView.load(URLRequest(url: url))
                return
            }
            let store = webView.configuration.websiteDataStore.httpCookieStore
            Task {
                await store.setCookie(cookie)
                webView.load(URLRequest(url: url))
            }
        }

        private static func authCookie(
            token: String,
            url: URL,
            sessionId: String
        ) -> HTTPCookie? {
            guard let host = url.host else { return nil }
            var properties: [HTTPCookiePropertyKey: Any] = [
                .name: "opensession_auth",
                .value: token,
                .domain: host,
                .path: "/api/sessions/\(sessionId)/assets/",
            ]
            if url.scheme == "https" { properties[.secure] = "TRUE" }
            return HTTPCookie(properties: properties)
        }
    }
}
#endif
