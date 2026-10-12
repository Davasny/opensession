import XCTest
@testable import OS1

final class HtmlRenderTests: XCTestCase {
    private let url = "/api/sessions/os-1/assets/raw/html-renders/fit-abc.html"

    private func result(_ extra: String = "") -> String {
        #"{"htmlRender":{"url":"\#(url)","path":"html-renders/fit-abc.html","title":" Fit ","height":360,"heights":[[744,359],[320,570],[1160,497]]},"message":"Shown inline."}"#
            + extra
    }

    func testReadsTheToolAnswer() throws {
        let ref = try XCTUnwrap(HtmlRenderReference.from(resultContent: result()))
        XCTAssertEqual(ref.url, url)
        XCTAssertEqual(ref.title, "Fit")
        XCTAssertEqual(ref.heights?.map(\.width), [320, 744, 1160])
    }

    func testReadsItInsideDispatcherProse() {
        XCTAssertNotNil(HtmlRenderReference.from(resultContent: "Result:\n" + result()))
    }

    func testNeverLoadsAnythingButAStoredRender() {
        for bad in [
            "https://evil.example/x.html",
            "/api/sessions/os-1/assets/raw/reports/x.html",
            "//evil.example/api/sessions/a/assets/raw/html-renders/x.html",
        ] {
            let text = #"{"htmlRender":{"url":"\#(bad)","path":"p","title":"t","height":300}}"#
            XCTAssertNil(HtmlRenderReference.from(resultContent: text), bad)
        }
        XCTAssertNil(HtmlRenderReference.from(resultContent: "Render failed: no"))
    }

    func testFrameHeightFollowsTheWebRule() throws {
        let ref = try XCTUnwrap(HtmlRenderReference.from(resultContent: result()))
        XCTAssertEqual(ref.frameHeight(width: 744, contentHeight: nil), 359)
        XCTAssertEqual(ref.frameHeight(width: 390, contentHeight: nil), 570)
        XCTAssertEqual(ref.frameHeight(width: 2000, contentHeight: nil), 497)
        XCTAssertEqual(ref.frameHeight(width: 390, contentHeight: 601), 601)
        var capped = ref
        capped.height = 200
        XCTAssertEqual(capped.frameHeight(width: 744, contentHeight: 800), 200)
    }

    func testRenderToolNames() {
        XCTAssertTrue(HtmlRenderReference.mayBeRenderTool("mcp__opensession-html__html_render", input: nil))
        XCTAssertTrue(HtmlRenderReference.mayBeRenderTool("mcp__oc__mcp_call", input: nil))
        XCTAssertFalse(HtmlRenderReference.mayBeRenderTool("mcp__opensession-html__html_preview", input: nil))
        XCTAssertFalse(HtmlRenderReference.mayBeRenderTool("Bash", input: nil))
    }

    func testFenceDocumentCarriesThemeVariables() {
        let doc = ArtifactDocument(kind: .html, source: "<p>x</p>")
            .html(textHex: "#e9e9e9", linkHex: "#58a6ff", backgroundHex: "#000000", dark: true)
        XCTAssertTrue(doc.contains("--card:#222222;"))
        XCTAssertTrue(doc.contains("--background:#000000;"))
    }
}
