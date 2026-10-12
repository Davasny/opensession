import Foundation
import SwiftUI

/// The composer's two suggestions, as on the web (lib/composer-prediction.ts):
/// a predicted next message in the empty composer, and typing autocomplete,
/// faint text after the caret. Neither ever sends; a double tap (or Tab)
/// types it in.
enum ComposerAutocomplete {
    /// How long the draft has to sit still before a completion is asked for.
    static let pause: Duration = .milliseconds(300)

    /// A completion fetched for the draft as it was (`base`).
    struct Suggestion: Equatable {
        let base: String
        let completion: String
    }

    /// The part of a suggestion still ahead of the caret, or nil. Typing the
    /// suggested characters keeps it (and shortens it); typing anything else,
    /// or deleting back into what was typed when it was asked for, retires it.
    static func ghostSuffix(draft: String, suggestion: Suggestion?) -> String? {
        guard let suggestion else { return nil }
        let full = suggestion.base + suggestion.completion
        guard draft.hasPrefix(suggestion.base), full.hasPrefix(draft),
              draft.count < full.count
        else { return nil }
        return String(full.dropFirst(draft.count))
    }

    /// Worth asking: the draft has something to finish. A draft that already
    /// ends a sentence gets nothing (the server checks this too).
    static func wantsCompletion(_ draft: String) -> Bool {
        guard draft.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 else { return false }
        return draft.range(
            of: #"[.?!…]["')\]]*\s*$"#, options: .regularExpression
        ) == nil
    }

    // MARK: - Availability

    @MainActor private static var cachedAvailability: Bool?

    /// Asked once per launch. A completion answered `available: false`
    /// flips it, so the composer stops asking.
    @MainActor
    static func available() async -> Bool {
        if let cachedAvailability { return cachedAvailability }
        guard let ok = try? await OS1API.composerAutocompleteAvailable() else { return false }
        cachedAvailability = ok
        return ok
    }

    /// The rest of `draft`, or nil. A refusal or provider error is a missed
    /// suggestion, never something to show: the draft is unaffected.
    @MainActor
    static func complete(sessionId: String, draft: String) async -> String? {
        guard let response = try? await OS1API.composerComplete(sessionId: sessionId, draft: draft)
        else { return nil }
        if response.available == false { cachedAvailability = false }
        guard let completion = response.completion, !completion.isEmpty else { return nil }
        return completion
    }
}

/// Marks the faint completion inside the composer's ghost text.
struct ComposerGhostRun: TextAttribute {}

/// Where the faint completion was last drawn, in the field's coordinates.
/// A plain box, not observed: drawing writes it, a double tap reads it.
final class ComposerGhostRects {
    var rects: [CGRect] = []

    /// A finger's worth of slack around each line, as on the web.
    func contains(_ point: CGPoint) -> Bool {
        rects.contains { $0.insetBy(dx: -16, dy: -12).contains(point) }
    }
}

/// Draws the ghost text unchanged and records the completion's line rects.
struct ComposerGhostRenderer: TextRenderer {
    let rects: ComposerGhostRects

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        var found: [CGRect] = []
        for line in layout {
            for run in line {
                if run[ComposerGhostRun.self] != nil { found.append(run.typographicBounds.rect) }
                context.draw(run)
            }
        }
        rects.rects = found
    }
}
