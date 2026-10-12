import SwiftUI

/// Per-composer state for the visible-title/canonical-reference split.
@MainActor
final class ComposerSessionProjectionState {
    private struct Transition {
        let before: ComposerSessionProjection
        let after: ComposerSessionProjection
    }

    private var undo: [Transition] = []
    private var redo: [Transition] = []
    private var cachedCanonical: String?
    private var cachedGeneration = -1
    private var cachedProjection: ComposerSessionProjection?

    /// Project known session references while retaining their raw ids or URLs
    /// in `canonical`. A title learned while the field is focused waits until
    /// blur, so a length-changing redraw cannot move the caret into a token.
    func binding(
        _ canonical: Binding<String>,
        titleGeneration: Int,
        refreshTitles: Bool
    ) -> Binding<String> {
        Binding(
            get: {
                self.projection(
                    for: canonical.wrappedValue,
                    titleGeneration: titleGeneration,
                    refreshTitles: refreshTitles
                ).displayText
            },
            set: { next in
                let current = canonical.wrappedValue
                if let transition = self.undo.last,
                   transition.after.canonicalText == current,
                   transition.before.displayText == next {
                    self.undo.removeLast()
                    self.redo.append(transition)
                    canonical.wrappedValue = transition.before.canonicalText
                    self.cache(
                        transition.before,
                        generation: refreshTitles ? titleGeneration : titleGeneration &- 1
                    )
                    return
                }
                if let transition = self.redo.last,
                   transition.before.canonicalText == current,
                   transition.after.displayText == next {
                    self.redo.removeLast()
                    self.undo.append(transition)
                    canonical.wrappedValue = transition.after.canonicalText
                    self.cache(
                        transition.after,
                        generation: refreshTitles ? titleGeneration : titleGeneration &- 1
                    )
                    return
                }

                let before = self.projection(
                    for: current,
                    titleGeneration: titleGeneration,
                    refreshTitles: refreshTitles
                )
                let afterCanonical = before.canonicalText(afterEditing: next)
                guard afterCanonical != current else { return }
                let overrides = refreshTitles
                    ? [:]
                    : Dictionary(uniqueKeysWithValues: before.references.map { ($0.id, $0.name) })
                let frozenIds = refreshTitles
                    ? Set<String>()
                    : ComposerSessionProjection.sessionIds(in: current)
                let after = ComposerSessionProjection(
                    afterCanonical,
                    titleOverrides: overrides,
                    frozenIds: frozenIds
                )
                self.undo.append(Transition(
                    before: before,
                    after: after
                ))
                if self.undo.count > 100 { self.undo.removeFirst() }
                self.redo.removeAll()
                canonical.wrappedValue = afterCanonical
                self.cache(
                    after,
                    generation: refreshTitles ? titleGeneration : titleGeneration &- 1
                )
            }
        )
    }

    private func projection(
        for canonical: String,
        titleGeneration: Int,
        refreshTitles: Bool
    ) -> ComposerSessionProjection {
        if cachedCanonical == canonical,
           let cachedProjection,
           cachedGeneration == titleGeneration || !refreshTitles {
            return cachedProjection
        }
        let projection = ComposerSessionProjection(canonical)
        cache(projection, generation: titleGeneration)
        return projection
    }

    /// Where the field shows each session reference, for the pill paint.
    /// Read after the binding's getter has projected the current draft.
    var displayedReferenceRanges: [NSRange] {
        cachedProjection?.references.map(\.displayRange) ?? []
    }

    private func cache(_ projection: ComposerSessionProjection, generation: Int) {
        cachedCanonical = projection.canonicalText
        cachedGeneration = generation
        cachedProjection = projection
    }
}
