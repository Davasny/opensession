import XCTest
@testable import OS1

final class ComposerAutocompleteTests: XCTestCase {
    private let suggestion = ComposerAutocomplete.Suggestion(base: "Can you check the", completion: " scroll position?")

    func testTypingThroughASuggestionShortensIt() {
        XCTAssertEqual(
            ComposerAutocomplete.ghostSuffix(draft: "Can you check the", suggestion: suggestion),
            " scroll position?"
        )
        XCTAssertEqual(
            ComposerAutocomplete.ghostSuffix(draft: "Can you check the scr", suggestion: suggestion),
            "oll position?"
        )
    }

    func testTypingSomethingElseOrDeletingRetiresIt() {
        XCTAssertNil(ComposerAutocomplete.ghostSuffix(draft: "Can you check the x", suggestion: suggestion))
        XCTAssertNil(ComposerAutocomplete.ghostSuffix(draft: "Can you check", suggestion: suggestion))
        XCTAssertNil(ComposerAutocomplete.ghostSuffix(
            draft: "Can you check the scroll position?", suggestion: suggestion
        ))
        XCTAssertNil(ComposerAutocomplete.ghostSuffix(draft: "Can you", suggestion: nil))
    }

    func testOnlyAnUnfinishedSentenceAsksForACompletion() {
        XCTAssertTrue(ComposerAutocomplete.wantsCompletion("Can you check the"))
        XCTAssertFalse(ComposerAutocomplete.wantsCompletion("a"))
        XCTAssertFalse(ComposerAutocomplete.wantsCompletion("Ship it."))
        XCTAssertFalse(ComposerAutocomplete.wantsCompletion("Is it done?\" "))
        XCTAssertFalse(ComposerAutocomplete.wantsCompletion("Wait\u{2026}"))
    }

    func testThePredictionFrameCarriesTheSuggestedMessage() {
        let frame = #"{"type":"composer_prediction","sessionId":"s1","text":" Ship it "}"#
        guard case .composerPrediction(let id, let text) = ServerEvent.parse(Data(frame.utf8)) else {
            return XCTFail("expected a prediction")
        }
        XCTAssertEqual(id, "s1")
        XCTAssertEqual(text, "Ship it")
        let retired = #"{"type":"composer_prediction","sessionId":"s1","text":null}"#
        guard case .composerPrediction(_, let none) = ServerEvent.parse(Data(retired.utf8)) else {
            return XCTFail("expected a prediction")
        }
        XCTAssertNil(none)
    }
}
