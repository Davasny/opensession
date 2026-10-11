import Observation
import SwiftStreamingMarkdown
import SwiftUI

#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// One transcript passage attached to the next message.
///
/// The renderer's native selection disappears when the composer takes focus,
/// so this also holds a weak platform anchor and paints the selected range as
/// a temporary TextKit highlight until the quote is sent or dismissed.
@Observable
@MainActor
final class TranscriptQuoteSelection {
    private(set) var text: String?
    /// The transcript entry the selection sits in, when the row said so.
    @ObservationIgnored private(set) var entryId: String?
    /// Set by the view model: "Comment" was chosen on the selection.
    @ObservationIgnored var onCommentRequest: (() -> Void)?
    @ObservationIgnored private var entryListeners: [String: any MarkdownListener] = [:]

    @ObservationIgnored private weak var sourceTextView: PlatformTextView?
    @ObservationIgnored private var sourceRange = NSRange(location: NSNotFound, length: 0)
    @ObservationIgnored private var sourceSnapshot: NSAttributedString?
    @ObservationIgnored private var sourceContent: String?
    @ObservationIgnored fileprivate weak var composerMarker: PlatformView?
    @ObservationIgnored fileprivate var stageGeneration = 0
    @ObservationIgnored private(set) lazy var listener: any MarkdownListener =
        TranscriptQuoteListener(selection: self)

    /// A listener that also records which entry a selection came from, so a
    /// comment can anchor to it. One per entry, kept so a row's renderer sees
    /// the same object on every body evaluation.
    func listener(entryId: String?) -> any MarkdownListener {
        guard let entryId else { return listener }
        if let existing = entryListeners[entryId] { return existing }
        if entryListeners.count > 400 { entryListeners.removeAll(keepingCapacity: true) }
        let made = TranscriptQuoteListener(selection: self, entryId: entryId)
        entryListeners[entryId] = made
        return made
    }

    func stage(_ candidate: String, entryId: String? = nil) {
        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else { return }
        if let entryId { self.entryId = entryId }
        if text == trimmed, let sourceTextView, sourceStillMatches(sourceTextView) { return }
        if text != trimmed { self.entryId = entryId }

        removeRetainedHighlight()
        text = trimmed
        stageGeneration += 1
        retainCurrentSelection(matching: trimmed)
    }

    func clear() {
        collapseNativeSelection()
        removeRetainedHighlight()
        text = nil
        entryId = nil
    }

    /// The selection as a comment anchor in `entryId`: the words plus the
    /// context around them in the text view they were selected in.
    func commentAnchor(entryId: String) -> TextAnchor? {
        guard let text else { return nil }
        if let sourceContent, sourceRange.location != NSNotFound,
           NSMaxRange(sourceRange) <= (sourceContent as NSString).length,
           let anchor = CommentAnchor.anchor(text: sourceContent, range: sourceRange, entryId: entryId) {
            return anchor
        }
        return CommentAnchor.anchor(exact: text, entryId: entryId)
    }

    fileprivate func requestComment(_ candidate: String, entryId: String?) {
        stage(candidate, entryId: entryId)
        onCommentRequest?()
    }

    func message(with draft: String) -> String {
        Self.message(quoting: text, draft: draft)
    }

    static func message(quoting quote: String?, draft: String) -> String {
        let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let quote else { return typed }
        let block = quote
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces).isEmpty ? ">" : "> \($0)" }
            .joined(separator: "\n")
        return typed.isEmpty ? block : "\(block)\n\n\(typed)"
    }

    #if os(macOS)
    fileprivate func stageChangedMacSelection(from previous: MacSelection?) {
        guard let textView = NSApp.keyWindow?.firstResponder as? NSTextView,
              !textView.isEditable,
              let storage = textView.textStorage
        else { return }
        let range = NSIntersectionRange(
            textView.selectedRange(),
            NSRange(location: 0, length: storage.length)
        )
        guard range.length > 0,
              previous?.view !== textView || previous?.range != range
        else { return }
        stage(storage.attributedSubstring(from: range).string)
    }
    #endif

    fileprivate func tapIsInsideComposer(_ point: CGPoint, in window: PlatformWindow) -> Bool {
        guard let marker = composerMarker, marker.window === window else { return false }
        return marker.bounds.contains(marker.convert(point, from: nil))
    }

    private func retainCurrentSelection(matching expected: String) {
        #if os(iOS)
        guard let textView = UIResponder.os1CurrentFirstResponder() as? UITextView,
              !textView.isEditable
        else { return }
        let range = NSIntersectionRange(
            textView.selectedRange,
            NSRange(location: 0, length: textView.attributedText.length)
        )
        guard range.length > 0,
              textView.attributedText.attributedSubstring(from: range).string
                .trimmingCharacters(in: .whitespacesAndNewlines) == expected
        else { return }
        sourceTextView = textView
        sourceRange = range
        sourceSnapshot = textView.attributedText.attributedSubstring(from: range)
        sourceContent = textView.attributedText.string
        textView.textStorage.addAttribute(
            .backgroundColor,
            value: UIColor(OS1VisualStyle.accent).withAlphaComponent(0.30),
            range: range
        )
        #else
        guard let textView = NSApp.keyWindow?.firstResponder as? NSTextView,
              !textView.isEditable,
              let storage = textView.textStorage
        else { return }
        let range = NSIntersectionRange(
            textView.selectedRange(),
            NSRange(location: 0, length: storage.length)
        )
        guard range.length > 0,
              storage.attributedSubstring(from: range).string
                .trimmingCharacters(in: .whitespacesAndNewlines) == expected
        else { return }
        sourceTextView = textView
        sourceRange = range
        sourceSnapshot = storage.attributedSubstring(from: range)
        sourceContent = storage.string
        storage.addAttribute(
            .backgroundColor,
            value: NSColor(OS1VisualStyle.accent).withAlphaComponent(0.30),
            range: range
        )
        #endif
    }

    private func removeRetainedHighlight() {
        defer {
            sourceTextView = nil
            sourceRange = NSRange(location: NSNotFound, length: 0)
            sourceSnapshot = nil
            sourceContent = nil
        }
        guard let sourceTextView,
              sourceTextView.window != nil,
              sourceRange.location != NSNotFound,
              sourceRange.length > 0,
              sourceStillMatches(sourceTextView)
        else { return }
        #if os(iOS)
        let range = NSIntersectionRange(
            sourceRange,
            NSRange(location: 0, length: sourceTextView.attributedText.length)
        )
        if range.length > 0 {
            sourceTextView.textStorage.removeAttribute(
                .backgroundColor,
                range: range
            )
            restoreBackgroundAttributes(in: sourceTextView.textStorage, range: range)
        }
        #else
        guard let storage = sourceTextView.textStorage else { return }
        let range = NSIntersectionRange(
            sourceRange,
            NSRange(location: 0, length: storage.length)
        )
        if range.length > 0 {
            storage.removeAttribute(
                .backgroundColor,
                range: range
            )
            restoreBackgroundAttributes(in: storage, range: range)
        }
        #endif
    }

    private func collapseNativeSelection() {
        guard let sourceTextView,
              sourceRange.location != NSNotFound,
              sourceRange.length > 0
        else { return }
        #if os(iOS)
        let end = min(NSMaxRange(sourceRange), sourceTextView.attributedText.length)
        sourceTextView.selectedRange = NSRange(location: end, length: 0)
        #else
        guard let storage = sourceTextView.textStorage else { return }
        let end = min(NSMaxRange(sourceRange), storage.length)
        sourceTextView.setSelectedRange(NSRange(location: end, length: 0))
        #endif
    }

    private func restoreBackgroundAttributes(in storage: NSTextStorage, range: NSRange) {
        guard let sourceSnapshot else { return }
        let snapshotRange = NSRange(location: 0, length: min(range.length, sourceSnapshot.length))
        sourceSnapshot.enumerateAttribute(.backgroundColor, in: snapshotRange) { value, local, _ in
            guard let value else { return }
            storage.addAttribute(
                .backgroundColor,
                value: value,
                range: NSRange(location: range.location + local.location, length: local.length)
            )
        }
    }

    private func sourceStillMatches(_ textView: PlatformTextView) -> Bool {
        guard let sourceSnapshot, let sourceContent else { return false }
        #if os(iOS)
        guard let storage = textView.attributedText else { return false }
        #else
        guard let storage = textView.textStorage else { return false }
        #endif
        let range = NSIntersectionRange(
            sourceRange,
            NSRange(location: 0, length: storage.length)
        )
        return storage.string == sourceContent
            && range == sourceRange
            && storage.attributedSubstring(from: range).string == sourceSnapshot.string
    }
}

private final class TranscriptQuoteListener: MarkdownListener {
    private weak var selection: TranscriptQuoteSelection?
    private let entryId: String?

    init(selection: TranscriptQuoteSelection, entryId: String? = nil) {
        self.selection = selection
        self.entryId = entryId
    }

    func onRender(markdown: RenderableDocument) async {}
    func onTableCopyTap(content: String) async {}
    func onTableDownloadTap(content: String) async {}
    func onImageTap(image: MarkdownImage) async {}

    func onContextMenuAppear(id: String, selectedContent: String) async {
        guard id == "os1-quote-selection" || id == "os1-comment-selection" else { return }
        await selection?.stage(selectedContent, entryId: entryId)
    }

    func onContextMenuTap(id: String, selectedContent: String) async {
        switch id {
        case "os1-quote-selection":
            await selection?.stage(selectedContent, entryId: entryId)
        case "os1-comment-selection":
            await selection?.requestComment(selectedContent, entryId: entryId)
        default:
            break
        }
    }
}

extension TextContextMenu {
    static let os1QuoteSelection = TextContextMenu(menuGroups: [
        TextContextMenuGroup(
            title: nil,
            image: nil,
            displayInline: true,
            items: [
                TextContextMenuItem(
                    id: "os1-quote-selection",
                    title: "Add to chat"
                ),
                TextContextMenuItem(
                    id: "os1-comment-selection",
                    title: "Comment"
                ),
            ]
        )
    ])
}

extension EnvironmentValues {
    @Entry var transcriptQuoteSelection: TranscriptQuoteSelection?
    /// The transcript entry a row renders, so a selection inside it can
    /// anchor a comment there.
    @Entry var transcriptAnchorEntryId: String?
}

extension View {
    func transcriptQuoteInteractions(_ selection: TranscriptQuoteSelection) -> some View {
        background(TranscriptQuoteRootMarker(selection: selection))
    }

    func transcriptQuoteComposerRegion(_ selection: TranscriptQuoteSelection) -> some View {
        background(TranscriptQuoteComposerMarker(selection: selection))
    }
}

#if os(iOS)
private typealias PlatformTextView = UITextView
private typealias PlatformView = UIView
private typealias PlatformWindow = UIWindow

@MainActor
private final class FirstResponderBox {
    static let shared = FirstResponderBox()
    weak var responder: UIResponder?
}

private extension UIResponder {
    @objc func os1CaptureFirstResponder(_ sender: Any?) {
        FirstResponderBox.shared.responder = self
    }

    static func os1CurrentFirstResponder() -> UIResponder? {
        FirstResponderBox.shared.responder = nil
        UIApplication.shared.sendAction(
            #selector(os1CaptureFirstResponder(_:)),
            to: nil,
            from: nil,
            for: nil
        )
        return FirstResponderBox.shared.responder
    }
}

private final class TranscriptQuoteMarkerView: UIView {
    var movedToWindow: ((UIWindow?) -> Void)?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        movedToWindow?(window)
    }
}

private struct TranscriptQuoteRootMarker: UIViewRepresentable {
    let selection: TranscriptQuoteSelection

    func makeCoordinator() -> Coordinator { Coordinator(selection: selection) }

    func makeUIView(context: Context) -> UIView {
        let view = TranscriptQuoteMarkerView()
        view.isUserInteractionEnabled = false
        view.movedToWindow = { context.coordinator.install(in: $0) }
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        context.coordinator.selection = selection
        context.coordinator.install(in: view.window)
    }

    static func dismantleUIView(_ view: UIView, coordinator: Coordinator) {
        coordinator.install(in: nil)
    }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var selection: TranscriptQuoteSelection
        private weak var window: UIWindow?
        private var recognizer: UITapGestureRecognizer?

        init(selection: TranscriptQuoteSelection) {
            self.selection = selection
        }

        func install(in window: UIWindow?) {
            guard self.window !== window else { return }
            if let recognizer { self.window?.removeGestureRecognizer(recognizer) }
            self.window = window
            guard let window else { return }
            let recognizer = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
            recognizer.cancelsTouchesInView = false
            recognizer.delegate = self
            window.addGestureRecognizer(recognizer)
            self.recognizer = recognizer
        }

        @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
            guard selection.text != nil, let window else { return }
            let point = recognizer.location(in: window)
            guard !selection.tapIsInsideComposer(point, in: window) else { return }
            let generation = selection.stageGeneration
            DispatchQueue.main.async { [weak self] in
                guard let self, self.selection.stageGeneration == generation else { return }
                self.selection.clear()
            }
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool { true }
    }
}

private struct TranscriptQuoteComposerMarker: UIViewRepresentable {
    let selection: TranscriptQuoteSelection

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        selection.composerMarker = view
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        selection.composerMarker = view
    }
}
#else
private typealias PlatformTextView = NSTextView
private typealias PlatformView = NSView
private typealias PlatformWindow = NSWindow

fileprivate struct MacSelection {
    weak var view: NSTextView?
    let range: NSRange
}

private final class TranscriptQuoteMarkerView: NSView {
    var movedToWindow: ((NSWindow?) -> Void)?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        movedToWindow?(window)
    }
}

private struct TranscriptQuoteRootMarker: NSViewRepresentable {
    let selection: TranscriptQuoteSelection

    func makeCoordinator() -> Coordinator { Coordinator(selection: selection) }

    func makeNSView(context: Context) -> NSView {
        let view = TranscriptQuoteMarkerView()
        view.movedToWindow = { context.coordinator.install(in: $0, marker: view) }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        context.coordinator.selection = selection
        context.coordinator.install(in: view.window, marker: view)
    }

    static func dismantleNSView(_ view: NSView, coordinator: Coordinator) {
        coordinator.removeMonitor()
    }

    @MainActor
    final class Coordinator {
        var selection: TranscriptQuoteSelection
        private weak var window: NSWindow?
        private weak var marker: NSView?
        private var monitor: Any?
        private var mouseDownSelection: MacSelection?
        private var mouseDownInsideTranscript = false

        init(selection: TranscriptQuoteSelection) {
            self.selection = selection
        }

        func install(in window: NSWindow?, marker: NSView) {
            self.marker = marker
            guard self.window !== window else { return }
            removeMonitor()
            self.window = window
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(
                matching: [.leftMouseDown, .leftMouseUp, .keyDown]
            ) { [weak self] event in
                MainActor.assumeIsolated { self?.handle(event) }
                return event
            }
        }

        func removeMonitor() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
            window = nil
        }

        private func handle(_ event: NSEvent) {
            guard let window, event.window === window else { return }
            if event.type == .keyDown, event.keyCode == 53 {
                selection.clear()
                return
            }
            let insideTranscript = marker.map {
                $0.bounds.contains($0.convert(event.locationInWindow, from: nil))
            } ?? false
            if event.type == .leftMouseDown, selection.text != nil,
               !selection.tapIsInsideComposer(event.locationInWindow, in: window) {
                selection.clear()
            }
            if event.type == .leftMouseDown {
                mouseDownInsideTranscript = insideTranscript
                let textView = window.firstResponder as? NSTextView
                mouseDownSelection = textView.map {
                    MacSelection(view: $0, range: $0.selectedRange())
                }
            } else if event.type == .leftMouseUp, mouseDownInsideTranscript {
                mouseDownInsideTranscript = false
                let previous = mouseDownSelection
                mouseDownSelection = nil
                DispatchQueue.main.async { [weak self] in
                    self?.selection.stageChangedMacSelection(from: previous)
                }
            } else if event.type == .leftMouseUp {
                mouseDownSelection = nil
            } else if event.type == .keyDown,
                      event.modifierFlags.contains(.shift),
                      [123, 124, 125, 126].contains(event.keyCode) {
                let textView = window.firstResponder as? NSTextView
                let previous = textView.map {
                    MacSelection(view: $0, range: $0.selectedRange())
                }
                DispatchQueue.main.async { [weak self] in
                    self?.selection.stageChangedMacSelection(from: previous)
                }
            }
        }
    }
}

private struct TranscriptQuoteComposerMarker: NSViewRepresentable {
    let selection: TranscriptQuoteSelection

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        selection.composerMarker = view
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        selection.composerMarker = view
    }
}
#endif
