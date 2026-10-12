import SwiftUI

#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Dims the composer's markdown quote lines (`ComposerQuoteLines`): the quoted
/// text takes the secondary label colour and its `>` the tertiary one, the
/// way a sent quote reads, so quoted context stands apart from the question.
///
/// It paints colour and nothing else, on the field's own text view, so the
/// draft string, glyph metrics, caret, selection, the IME's marked text and
/// the send key all stay the stock TextField's. On iOS it uses TextKit 2
/// rendering attributes, which never touch the text storage; the Mac's field
/// editor and resting cell take foreground-colour attributes only. It never
/// repaints while the IME is composing.
///
/// Install it as a `.background` on the TextField itself: it finds the field's
/// platform text view by frame.
struct ComposerQuoteHighlight: View {
    let text: String
    /// Session references, painted as accent pills like the web's.
    var sessionRanges: [NSRange] = []

    var body: some View {
        ComposerQuoteHighlightBridge(text: text, sessionRanges: sessionRanges)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

#if os(iOS)
private struct ComposerQuoteHighlightBridge: UIViewRepresentable {
    let text: String
    let sessionRanges: [NSRange]

    func makeCoordinator() -> ComposerQuotePainter { ComposerQuotePainter() }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        context.coordinator.schedule(text: text, sessionRanges: sessionRanges, marker: view)
    }
}

@MainActor
final class ComposerQuotePainter {
    private weak var textView: UITextView?
    private var text = ""
    private var painted: [ComposerQuoteLines.Line] = []
    private var sessionRanges: [NSRange] = []
    private var paintedSessions: [NSRange] = []
    private var scheduled = false

    func schedule(text: String, sessionRanges: [NSRange], marker: UIView) {
        self.text = text
        self.sessionRanges = sessionRanges
        guard !scheduled else { return }
        scheduled = true
        // After SwiftUI has pushed the new string into the field.
        DispatchQueue.main.async { [weak self, weak marker] in
            guard let self else { return }
            self.scheduled = false
            guard let marker else { return }
            self.paint(marker: marker, retry: true)
        }
    }

    private func paint(marker: UIView, retry: Bool) {
        guard let textView = textView?.window != nil ? textView : find(from: marker) else { return }
        self.textView = textView
        // Mid-composition the marked range belongs to the IME.
        guard textView.markedTextRange == nil else { return }
        guard textView.text == text else {
            if retry {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self, weak marker] in
                    guard let marker else { return }
                    self?.paint(marker: marker, retry: false)
                }
            }
            return
        }
        let lines = ComposerQuoteLines.lines(in: text)
        let length = (text as NSString).length
        let sessions = sessionRanges.filter { NSMaxRange($0) <= length }
        guard lines != painted || sessions != paintedSessions || !lines.isEmpty || !sessions.isEmpty
        else { return }
        painted = lines
        paintedSessions = sessions
        let accent = UIColor(OS1VisualStyle.accent)
        if let layout = textView.textLayoutManager,
           let content = layout.textContentManager {
            layout.removeRenderingAttribute(.foregroundColor, for: layout.documentRange)
            layout.removeRenderingAttribute(.backgroundColor, for: layout.documentRange)
            for session in sessions {
                if let range = Self.textRange(session, in: content) {
                    layout.addRenderingAttribute(.foregroundColor, value: accent, for: range)
                    layout.addRenderingAttribute(
                        .backgroundColor, value: accent.withAlphaComponent(0.16), for: range
                    )
                }
            }
            for line in lines {
                if let range = Self.textRange(line.line, in: content) {
                    layout.addRenderingAttribute(.foregroundColor, value: UIColor.secondaryLabel, for: range)
                }
                if let range = Self.textRange(line.marker, in: content) {
                    layout.addRenderingAttribute(.foregroundColor, value: UIColor.tertiaryLabel, for: range)
                }
            }
        } else {
            // TextKit 1 has no rendering-only colour on iOS: recolour the
            // storage. Attributes only, never characters, so the string the
            // binding reads back is unchanged.
            let storage = textView.textStorage
            let full = NSRange(location: 0, length: storage.length)
            storage.beginEditing()
            storage.addAttribute(.foregroundColor, value: UIColor.label, range: full)
            storage.removeAttribute(.backgroundColor, range: full)
            for line in lines {
                storage.addAttribute(.foregroundColor, value: UIColor.secondaryLabel, range: line.line)
                storage.addAttribute(.foregroundColor, value: UIColor.tertiaryLabel, range: line.marker)
            }
            for session in sessions {
                storage.addAttribute(.foregroundColor, value: accent, range: session)
                storage.addAttribute(.backgroundColor, value: accent.withAlphaComponent(0.16), range: session)
            }
            storage.endEditing()
            textView.typingAttributes[.foregroundColor] = UIColor.label
        }
    }

    private static func textRange(_ range: NSRange, in content: NSTextContentManager) -> NSTextRange? {
        let start = content.documentRange.location
        guard let from = content.location(start, offsetBy: range.location),
              let to = content.location(from, offsetBy: range.length)
        else { return nil }
        return NSTextRange(location: from, end: to)
    }

    /// The editable text view under the marker: the composer field.
    private func find(from marker: UIView) -> UITextView? {
        guard let window = marker.window else { return nil }
        let center = marker.convert(CGPoint(x: marker.bounds.midX, y: marker.bounds.midY), to: nil)
        var stack: [UIView] = [window]
        while let view = stack.popLast() {
            if let textView = view as? UITextView, textView.isEditable,
               textView.convert(textView.bounds, to: nil).contains(center) {
                return textView
            }
            stack.append(contentsOf: view.subviews)
        }
        return nil
    }
}
#else
private struct ComposerQuoteHighlightBridge: NSViewRepresentable {
    let text: String
    let sessionRanges: [NSRange]

    func makeCoordinator() -> ComposerQuotePainter { ComposerQuotePainter() }

    func makeNSView(context: Context) -> NSView { NSView() }

    func updateNSView(_ view: NSView, context: Context) {
        context.coordinator.schedule(text: text, sessionRanges: sessionRanges, marker: view)
    }
}

@MainActor
final class ComposerQuotePainter {
    private weak var field: NSView?
    private var text = ""
    private var scheduled = false
    private var observers: [NSObjectProtocol] = []
    private var sessionRanges: [NSRange] = []

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    func schedule(text: String, sessionRanges: [NSRange], marker: NSView) {
        self.text = text
        self.sessionRanges = sessionRanges
        guard !scheduled else { return }
        scheduled = true
        DispatchQueue.main.async { [weak self, weak marker] in
            guard let self else { return }
            self.scheduled = false
            guard let marker else { return }
            self.paint(marker: marker, attempts: [0.05, 0.25])
        }
    }

    /// SwiftUI pushes the string into the field, and may reset its
    /// attributes, on its own schedule: paint now and again shortly after.
    /// A pass that finds nothing to change does nothing.
    private func paint(marker: NSView, attempts: [Double]) {
        if let field = field?.window != nil ? field : find(from: marker) {
            if self.field !== field {
                self.field = field
                observe(field)
            }
            repaint()
        }
        guard let next = attempts.first else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + next) { [weak self, weak marker] in
            guard let self, let marker else { return }
            self.paint(marker: marker, attempts: Array(attempts.dropFirst()))
        }
    }

    /// Editing hands the text to the window's field editor, which draws its
    /// own copy: paint again whenever editing starts or ends.
    private func observe(_ field: NSView) {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = [NSControl.textDidBeginEditingNotification, NSControl.textDidEndEditingNotification]
            .map { name in
                NotificationCenter.default.addObserver(forName: name, object: field, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated {
                        DispatchQueue.main.async { self?.repaint() }
                    }
                }
            }
    }

    private func repaint() {
        guard let field else { return }
        let lines = ComposerQuoteLines.lines(in: text)
        if let textField = field as? NSTextField {
            if let editor = textField.currentEditor() as? NSTextView {
                paint(editor, lines: lines)
            } else if textField.stringValue == text {
                // At rest an NSTextField draws its cell's attributed string.
                let value = NSMutableAttributedString(attributedString: textField.attributedStringValue)
                let full = NSRange(location: 0, length: value.length)
                value.addAttribute(.foregroundColor, value: NSColor.labelColor, range: full)
                value.removeAttribute(.backgroundColor, range: full)
                for line in lines where NSMaxRange(line.line) <= value.length {
                    value.addAttribute(.foregroundColor, value: NSColor.secondaryLabelColor, range: line.line)
                    value.addAttribute(.foregroundColor, value: NSColor.tertiaryLabelColor, range: line.marker)
                }
                let accent = NSColor(OS1VisualStyle.accent)
                for session in sessionRanges where NSMaxRange(session) <= value.length {
                    value.addAttribute(.foregroundColor, value: accent, range: session)
                    value.addAttribute(.backgroundColor, value: accent.withAlphaComponent(0.16), range: session)
                }
                if !value.isEqual(to: textField.attributedStringValue) {
                    textField.attributedStringValue = value
                }
            }
        } else if let textView = field as? NSTextView {
            paint(textView, lines: lines)
        }
    }

    /// The field editor recolours its own storage: an AppKit field editor
    /// draws past TextKit 2 rendering attributes. Attributes only, never
    /// characters, and never while the IME holds marked text, so the string
    /// the field hands back to SwiftUI, the caret and the selection are
    /// untouched.
    private func paint(_ textView: NSTextView, lines: [ComposerQuoteLines.Line]) {
        guard !textView.hasMarkedText(), textView.string == text,
              let storage = textView.textStorage
        else { return }
        let full = NSRange(location: 0, length: storage.length)
        var wanted: [(NSRange, NSColor)] = [(full, .labelColor)]
        for line in lines where NSMaxRange(line.line) <= storage.length {
            wanted.append((line.line, .secondaryLabelColor))
            wanted.append((line.marker, .tertiaryLabelColor))
        }
        let accent = NSColor(OS1VisualStyle.accent)
        let pills = sessionRanges.filter { NSMaxRange($0) <= storage.length }
        for session in pills { wanted.append((session, accent)) }
        // Skip the write when every run already has its colour.
        let target = NSMutableAttributedString(attributedString: storage)
        target.removeAttribute(.backgroundColor, range: full)
        for (range, color) in wanted { target.addAttribute(.foregroundColor, value: color, range: range) }
        for session in pills {
            target.addAttribute(.backgroundColor, value: accent.withAlphaComponent(0.16), range: session)
        }
        guard !target.isEqual(to: storage) else { return }
        // No selection write: an attribute edit leaves it where it was, and
        // setting it would post a selection change for SwiftUI to map
        // against a string it may be mid-way through replacing.
        storage.beginEditing()
        storage.removeAttribute(.backgroundColor, range: full)
        for (range, color) in wanted { storage.addAttribute(.foregroundColor, value: color, range: range) }
        for session in pills {
            storage.addAttribute(.backgroundColor, value: accent.withAlphaComponent(0.16), range: session)
        }
        storage.endEditing()
        textView.typingAttributes[.foregroundColor] = NSColor.labelColor
    }

    /// The editable text field (or text view) under the marker.
    private func find(from marker: NSView) -> NSView? {
        guard let root = marker.window?.contentView else { return nil }
        let center = marker.convert(NSPoint(x: marker.bounds.midX, y: marker.bounds.midY), to: nil)
        var stack: [NSView] = [root]
        while let view = stack.popLast() {
            let editable = (view as? NSTextField)?.isEditable == true
                || ((view as? NSTextView)?.isEditable == true && !(view.superview is NSClipView && view.superview?.superview?.superview is NSTextField))
            if editable, view.convert(view.bounds, to: nil).contains(center) {
                return view
            }
            stack.append(contentsOf: view.subviews)
        }
        return nil
    }
}
#endif
