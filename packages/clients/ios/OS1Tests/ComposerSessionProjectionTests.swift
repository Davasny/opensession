import SwiftUI
import XCTest
@testable import OS1

@MainActor
final class ComposerSessionProjectionTests: XCTestCase {
    private let id = "os-01a006d8-eddd-7000-bca2-b010caf2d8e7"
    private let title = "Clean pasted session links"
    private var serverOrigin: String { ServerConfig.shared.baseURL!.absoluteString }

    override func setUp() async throws {
        SessionLinks.register(titles: [id: title])
    }

    func testNamedSessionMentionProjectsTitleButRetainsCanonicalId() {
        let canonical = "Compare @session:\(id) now"
        let projection = ComposerSessionProjection(canonical)

        XCTAssertEqual(projection.displayText, "Compare \(title) now")
        XCTAssertEqual(projection.canonicalText, canonical)
    }

    func testPastedSessionURLProjectsTitleButRetainsCanonicalURL() {
        let url = "\(serverOrigin)/workspace/ws-example/session/\(id)"
        let canonical = "Use \(url) for context"
        let projection = ComposerSessionProjection(canonical)

        XCTAssertEqual(projection.displayText, "Use \(title) for context")
        XCTAssertEqual(
            projection.canonicalText(afterEditing: projection.displayText + "."),
            canonical + "."
        )
    }

    func testEditingOutsideNameKeepsRawReference() {
        let canonical = "Compare @session:\(id) now"
        let projection = ComposerSessionProjection(canonical)

        XCTAssertEqual(
            projection.canonicalText(afterEditing: "Please " + projection.displayText),
            "Please " + canonical
        )
    }

    func testDeletingProjectedNameDeletesWholeReference() {
        let canonical = "Compare @session:\(id) now"
        let projection = ComposerSessionProjection(canonical)

        XCTAssertEqual(
            projection.canonicalText(afterEditing: "Compare  now"),
            "Compare  now"
        )
    }

    func testUnknownAndCodeReferencesStayRaw() {
        let unknown = "os-01a00733-0547-7000-9abb-cc2b8fc3502f"
        let canonical = "`@session:\(id)` then @session:\(unknown) and \(id)"

        XCTAssertEqual(ComposerSessionProjection(canonical).displayText, canonical)
    }

    func testMatchingPathOnAnotherHostStaysRaw() {
        let canonical = "https://example.com/session/\(id)"

        XCTAssertEqual(ComposerSessionProjection(canonical).displayText, canonical)
    }

    func testMalformedInternalSessionPathStaysRaw() {
        let canonical = "\(serverOrigin)/other/session/\(id)"

        XCTAssertEqual(ComposerSessionProjection(canonical).displayText, canonical)
    }

    func testDoubledSlashSessionPathStaysRaw() {
        let canonical = "\(serverOrigin)//session/\(id)"

        XCTAssertEqual(ComposerSessionProjection(canonical).displayText, canonical)
    }

    func testSessionMentionInsideURLQueryDoesNotOverlapURLProjection() {
        let other = "os-01a00733-0547-7000-9abb-cc2b8fc3502f"
        SessionLinks.register(titles: [id: title, other: "Other session"])
        let canonical = "\(serverOrigin)/session/\(id)?ref=@session:\(other)"

        XCTAssertEqual(
            ComposerSessionProjection(canonical).displayText,
            title
        )
    }

    func testSessionMentionRequiresATrailingBoundary() {
        let canonical = "@session:\(id)-extra"

        XCTAssertEqual(ComposerSessionProjection(canonical).displayText, canonical)
    }

    func testDuplicateTitlesStayRawRatherThanRiskingTheWrongId() {
        let other = "os-01a00733-0547-7000-9abb-cc2b8fc3502f"
        SessionLinks.register(titles: [id: title, other: title])
        let canonical = "Compare @session:\(id) with @session:\(other)"

        XCTAssertEqual(ComposerSessionProjection(canonical).displayText, canonical)
    }

    func testTitleAlreadyPresentAsProseLeavesReferenceRaw() {
        let canonical = "@session:\(title) means @session:\(id)"

        XCTAssertEqual(ComposerSessionProjection(canonical).displayText, canonical)
    }

    func testUndoRestoresCanonicalReferenceRatherThanVisibleTitle() {
        let canonical = "Compare @session:\(id) now"
        var draft = canonical
        let raw = Binding(get: { draft }, set: { draft = $0 })
        let state = ComposerSessionProjectionState()
        let generation = TranscriptLinks.shared.generation
        let projected = state.binding(raw, titleGeneration: generation, refreshTitles: true)
        let before = projected.wrappedValue

        projected.wrappedValue = "Compare  now"
        XCTAssertEqual(draft, "Compare  now")

        state.binding(raw, titleGeneration: generation, refreshTitles: true).wrappedValue = before
        XCTAssertEqual(draft, canonical)
    }

    func testRenameWaitsForBlurWhileEditing() {
        let canonical = "Compare @session:\(id) now"
        var draft = canonical
        let raw = Binding(get: { draft }, set: { draft = $0 })
        let state = ComposerSessionProjectionState()
        var generation = TranscriptLinks.shared.generation

        XCTAssertEqual(
            state.binding(raw, titleGeneration: generation, refreshTitles: false).wrappedValue,
            "Compare \(title) now"
        )
        SessionLinks.register(titles: [id: "A much longer renamed session title"])
        generation = TranscriptLinks.shared.generation
        let focused = state.binding(raw, titleGeneration: generation, refreshTitles: false)
        focused.wrappedValue = "Compare \(title) now!"
        XCTAssertEqual(focused.wrappedValue, "Compare \(title) now!")

        XCTAssertEqual(
            state.binding(raw, titleGeneration: generation, refreshTitles: true).wrappedValue,
            "Compare A much longer renamed session title now!"
        )
    }

    func testNewlyLearnedTitleWaitsForBlurWhileEditing() {
        SessionLinks.register(titles: [:])
        let canonical = "Compare @session:\(id) now"
        var draft = canonical
        let raw = Binding(get: { draft }, set: { draft = $0 })
        let state = ComposerSessionProjectionState()
        var generation = TranscriptLinks.shared.generation
        XCTAssertEqual(
            state.binding(raw, titleGeneration: generation, refreshTitles: false).wrappedValue,
            canonical
        )

        SessionLinks.register(titles: [id: title])
        generation = TranscriptLinks.shared.generation
        let focused = state.binding(raw, titleGeneration: generation, refreshTitles: false)
        focused.wrappedValue = canonical + "!"
        XCTAssertEqual(focused.wrappedValue, canonical + "!")

        XCTAssertEqual(
            state.binding(raw, titleGeneration: generation, refreshTitles: true).wrappedValue,
            "Compare \(title) now!"
        )
    }
}
