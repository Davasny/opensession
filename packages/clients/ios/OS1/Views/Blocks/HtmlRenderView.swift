import SwiftUI
import WebKit

/// The pages a turn showed with `html_render`, under the turn: the answer
/// itself, so like a suggested task they stay put whether the fold is open.
struct HtmlRendersView: View {
    let renders: [HtmlRenderItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(renders) { item in
                HtmlRenderView(render: item.render)
            }
        }
        .padding(.top, 8)
    }
}

/// One render: the page on the transcript's background, as tall as the page
/// at this width (the server's measurement until the page reports its own),
/// with its title and an expand control in a quiet row underneath.
///
/// The page runs its own script, so the web view holds no credential at
/// all: the app fetches the bytes with its own authorized request and hands
/// them over as a string with no base URL, in a non-persistent store. The
/// page can reach nothing of this app, and every link leaves the view.
struct HtmlRenderView: View {
    let render: HtmlRenderReference

    @State private var width: Double = HtmlRenderReference.columnWidth
    @State private var contentHeight: Double?
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HtmlRenderWebView(render: render, scrolls: false) { contentHeight = $0 }
                .frame(height: render.frameHeight(width: width, contentHeight: contentHeight))
                .onGeometryChange(for: Double.self) { Double($0.size.width) } action: { width = $0 }
            HStack(spacing: 8) {
                Text(render.title)
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Button {
                    expanded = true
                } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.textFaint)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Expand \(render.title)")
            }
        }
        .accessibilityElement(children: .contain)
        #if os(iOS)
        .fullScreenCover(isPresented: $expanded) {
            ExpandedHtmlRender(render: render)
        }
        #else
        .sheet(isPresented: $expanded) {
            ExpandedHtmlRender(render: render)
                .frame(minWidth: 720, idealWidth: 960, minHeight: 520, idealHeight: 720)
        }
        #endif
    }
}

private struct ExpandedHtmlRender: View {
    let render: HtmlRenderReference

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(render.title)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding()
            HtmlRenderWebView(render: render, scrolls: true) { _ in }
                .padding(.horizontal)
        }
        .background(OS1VisualStyle.background)
    }
}

private struct HtmlRenderWebView: PlatformViewRepresentable {
    let render: HtmlRenderReference
    let scrolls: Bool
    let onContentHeight: (Double) -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openURL) private var openURL

    #if os(iOS)
    func makeUIView(context: Context) -> WKWebView { make(context) }
    func updateUIView(_ webView: WKWebView, context: Context) { update(webView, context) }
    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.tearDown(webView)
    }
    #else
    func makeNSView(context: Context) -> WKWebView { make(context) }
    func updateNSView(_ webView: WKWebView, context: Context) { update(webView, context) }
    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.tearDown(webView)
    }
    #endif

    func makeCoordinator() -> Coordinator { Coordinator() }

    private func make(_ context: Context) -> WKWebView {
        let coordinator = context.coordinator
        coordinator.onContentHeight = onContentHeight
        coordinator.openURL = { openURL($0) }
        let webView = coordinator.make(scrolls: scrolls)
        coordinator.theme = theme
        coordinator.load(render, in: webView)
        return webView
    }

    private func update(_ webView: WKWebView, _ context: Context) {
        let coordinator = context.coordinator
        coordinator.onContentHeight = onContentHeight
        coordinator.openURL = { openURL($0) }
        coordinator.apply(theme: theme, to: webView)
    }

    private var theme: String {
        let dark = colorScheme == .dark
        return HtmlTheme.message(
            dark: dark,
            variables: HtmlTheme.variables(
                dark: dark,
                background: OS1VisualStyle.hex(of: OS1VisualStyle.background, dark: dark),
                foreground: OS1VisualStyle.hex(of: OS1VisualStyle.text, dark: dark),
                link: OS1VisualStyle.hex(of: OS1VisualStyle.link, dark: dark)
            )
        )
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var onContentHeight: ((Double) -> Void)?
        var openURL: ((URL) -> Void)?
        var theme = ""
        private var appliedTheme: String?
        private var loadedURL: String?
        private var ready = false

        /// Reports the page's height the way the server measures it. The
        /// page's own bootstrap only reports inside a frame; here it is the
        /// top document, so the view asks for it instead.
        private static let heightScript = WKUserScript(
            source: """
            (function () {
              var last = -1;
              function report() {
                var r = document.documentElement;
                var h = Math.ceil(r.scrollHeight > r.clientHeight ? r.scrollHeight : r.getBoundingClientRect().height);
                if (h === last) return;
                last = h;
                window.webkit.messageHandlers.osHeight.postMessage(h);
              }
              if (window.ResizeObserver) new ResizeObserver(report).observe(document.documentElement);
              window.addEventListener('load', report);
              report();
            })();
            """,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )

        func make(scrolls: Bool) -> WKWebView {
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            configuration.userContentController.addUserScript(Self.heightScript)
            configuration.userContentController.add(WeakScriptHandler(self), name: "osHeight")
            let webView = WKWebView(frame: .zero, configuration: configuration)
            webView.navigationDelegate = self
            webView.uiDelegate = self
            #if os(iOS)
            webView.isOpaque = false
            webView.backgroundColor = .clear
            webView.scrollView.backgroundColor = .clear
            webView.scrollView.isScrollEnabled = scrolls
            webView.scrollView.bounces = scrolls
            #else
            webView.setValue(false, forKey: "drawsBackground")
            #endif
            return webView
        }

        func tearDown(_ webView: WKWebView) {
            webView.configuration.userContentController.removeScriptMessageHandler(forName: "osHeight")
        }

        func load(_ render: HtmlRenderReference, in webView: WKWebView) {
            guard loadedURL != render.url else { return }
            loadedURL = render.url
            Task { [weak webView] in
                guard let data = try? await OS1API.htmlRenderData(url: render.url),
                      let webView
                else { return }
                webView.loadHTMLString(String(decoding: data, as: UTF8.self), baseURL: nil)
            }
        }

        func apply(theme: String, to webView: WKWebView) {
            self.theme = theme
            guard ready, appliedTheme != theme else { return }
            appliedTheme = theme
            webView.evaluateJavaScript("window.postMessage(\(theme), '*')")
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            ready = true
            apply(theme: theme, to: webView)
        }

        nonisolated func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let height = (message.body as? NSNumber)?.doubleValue, height > 0 else { return }
            MainActor.assumeIsolated { onContentHeight?(height) }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            // The string load arrives as `.other` on `about:blank`; an
            // in-page anchor keeps the page. Anything else leaves the view.
            let url = navigationAction.request.url
            if navigationAction.navigationType == .other, url?.absoluteString == "about:blank" {
                decisionHandler(.allow)
                return
            }
            if let url, url.scheme == "about" {
                decisionHandler(.allow)
                return
            }
            decisionHandler(.cancel)
            if navigationAction.navigationType == .linkActivated, let url, isWebURL(url) {
                openURL?(url)
            }
        }

        /// The page's bootstrap aims a top-level page's links at a new
        /// window; that window is the reader's browser.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url, isWebURL(url) {
                openURL?(url)
            }
            return nil
        }
    }
}

private func isWebURL(_ url: URL) -> Bool {
    ["http", "https"].contains(url.scheme?.lowercased() ?? "")
}

/// A script handler that does not keep its coordinator alive: the user
/// content controller retains its handlers for the web view's lifetime.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

#if os(iOS)
private typealias PlatformViewRepresentable = UIViewRepresentable
#else
private typealias PlatformViewRepresentable = NSViewRepresentable
#endif
