import SwiftStreamingMarkdown
import SwiftUI

/// `SwiftStreamingMarkdown.MarkdownView`, with the parse kept across row
/// lifetimes.
///
/// The library's view holds its parsed document in a `@StateObject` and
/// parses in a `.task`. A transcript is a `LazyVStack`, which destroys a row's
/// state the moment it leaves the realization window, so every message
/// scrolled back into view was drawn EMPTY (zero height), parsed again, and
/// then grew to its real height. On a long session that is a height change
/// under the reader's finger on every row, which is what made scrolling feel
/// slow and jumpy. Here the parse is looked up by text and config first, so
/// a row that has been drawn once comes back at its full height in the same
/// frame; only a never-seen message pays for an asynchronous parse.
struct CachedMarkdownView: View {
    let text: String
    let config: MarkdownRenderConfig
    var listener: MarkdownListener? = nil

    /// The newest document this view parsed itself. Kept when the text moves
    /// on, so a changed message shows its previous rendering rather than
    /// blinking empty while the new one parses.
    @State private var parsed: RenderableDocument?

    var body: some View {
        let key = MarkdownDocumentCache.Key(text: text, config: config)
        let document = MarkdownDocumentCache.shared.document(for: key)
        DocumentView(
            renderableDocument: document ?? parsed ?? .empty,
            config: config,
            listener: listener
        )
        .task(id: key) {
            if document != nil { return }
            let next = await MarkdownDocumentCache.shared.parse(key)
            if !Task.isCancelled { parsed = next }
        }
    }
}

/// Parsed markdown by source text and render config, shared by every
/// `CachedMarkdownView`. Bounded: past `capacity` entries the oldest half is
/// dropped, which keeps a long session's recent rows hot without letting a
/// day of reading grow without limit.
@MainActor
final class MarkdownDocumentCache {
    static let shared = MarkdownDocumentCache()

    struct Key: Hashable, Sendable {
        let text: String
        let config: MarkdownRenderConfig
    }

    private let capacity: Int
    private var documents: [Key: RenderableDocument] = [:]
    private var order: [Key] = []
    private var inFlight: [Key: Task<RenderableDocument, Never>] = [:]

    init(capacity: Int = 600) {
        self.capacity = capacity
    }

    func document(for key: Key) -> RenderableDocument? {
        documents[key]
    }

    /// Parse off the main actor. Two rows asking for the same text (a
    /// re-created row whose previous task is still running) share one parse.
    func parse(_ key: Key) async -> RenderableDocument {
        if let cached = documents[key] { return cached }
        if let running = inFlight[key] { return await running.value }
        let task = Task.detached(priority: .userInitiated) {
            await MarkdownParserImpl().parse(text: key.text, config: key.config)
        }
        inFlight[key] = task
        let document = await task.value
        inFlight[key] = nil
        store(document, for: key)
        return document
    }

    func store(_ document: RenderableDocument, for key: Key) {
        if documents[key] == nil {
            if order.count >= capacity {
                let dropped = order.prefix(capacity / 2)
                for old in dropped { documents[old] = nil }
                order.removeFirst(dropped.count)
            }
            order.append(key)
        }
        documents[key] = document
    }

    var count: Int { documents.count }
}
