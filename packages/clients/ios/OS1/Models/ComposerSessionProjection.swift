import Foundation

/// The named view of session references shown while composing.
///
/// `canonicalText` remains the source of truth for drafts and sends. The field
/// renders `displayText`, where a known session id or URL is replaced by that
/// session's title, and edits to the projected field are mapped back onto the
/// canonical text.
@MainActor
struct ComposerSessionProjection {
    struct Reference: Equatable {
        let id: String
        let canonicalRange: NSRange
        let displayRange: NSRange
        let name: String
        let title: String
    }

    let canonicalText: String
    let displayText: String
    let references: [Reference]

    init(
        _ canonicalText: String,
        titleOverrides: [String: String] = [:],
        frozenIds: Set<String> = []
    ) {
        self.canonicalText = canonicalText
        let matches = Self.matches(
            in: canonicalText,
            titleOverrides: titleOverrides,
            frozenIds: frozenIds
        )
        let source = canonicalText as NSString
        var shown = ""
        var cursor = 0
        var references: [Reference] = []

        for match in matches {
            shown += source.substring(with: NSRange(
                location: cursor,
                length: match.range.location - cursor
            ))
            let start = (shown as NSString).length
            shown += match.title
            references.append(Reference(
                id: match.id,
                canonicalRange: match.range,
                displayRange: NSRange(location: start, length: (match.title as NSString).length),
                name: match.name,
                title: match.title
            ))
            cursor = NSMaxRange(match.range)
        }
        shown += source.substring(from: cursor)
        displayText = shown
        self.references = references
    }

    /// Apply one field edit without ever replacing the canonical draft with
    /// its projected titles. Editing any part of a title consumes that whole
    /// reference, matching its atomic presentation.
    func canonicalText(afterEditing nextDisplayText: String) -> String {
        guard nextDisplayText != displayText else { return canonicalText }
        let previous = Array(displayText.utf16)
        let next = Array(nextDisplayText.utf16)
        var start = 0
        while start < previous.count, start < next.count, previous[start] == next[start] {
            start += 1
        }

        var previousEnd = previous.count
        var nextEnd = next.count
        while previousEnd > start, nextEnd > start,
              previous[previousEnd - 1] == next[nextEnd - 1] {
            previousEnd -= 1
            nextEnd -= 1
        }

        let touched = references.filter { reference in
            let range = reference.displayRange
            return (start < NSMaxRange(range) && previousEnd > range.location)
                || (start == previousEnd && start > range.location && start < NSMaxRange(range))
        }
        let mappedStart = canonicalOffset(forDisplayOffset: start)
        let mappedEnd = canonicalOffset(forDisplayOffset: previousEnd)
        let canonicalStart = min(
            mappedStart,
            touched.map(\.canonicalRange.location).min() ?? mappedStart
        )
        let canonicalEnd = max(
            mappedEnd,
            touched.map { NSMaxRange($0.canonicalRange) }.max() ?? mappedEnd
        )
        let inserted = (nextDisplayText as NSString).substring(with: NSRange(
            location: start,
            length: nextEnd - start
        ))
        return (canonicalText as NSString).replacingCharacters(
            in: NSRange(location: canonicalStart, length: canonicalEnd - canonicalStart),
            with: inserted
        )
    }

    private func canonicalOffset(forDisplayOffset offset: Int) -> Int {
        var delta = 0
        for reference in references {
            if offset <= reference.displayRange.location { return offset + delta }
            if offset < NSMaxRange(reference.displayRange) {
                return reference.canonicalRange.location
            }
            delta += reference.canonicalRange.length - reference.displayRange.length
        }
        return offset + delta
    }

    private struct Match {
        let id: String
        let range: NSRange
        let name: String
        let title: String
    }

    private static let uuidV7 =
        "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    private static let idPattern = try! NSRegularExpression(
        pattern: "@session:((?:os|bks)-\(uuidV7))(?![\\w-])",
        options: [.caseInsensitive]
    )
    private static let urlPattern = try! NSRegularExpression(
        pattern: "https?://[^\\s<>`]+",
        options: [.caseInsensitive]
    )
    private static let fencePattern = try! NSRegularExpression(
        pattern: "```[\\s\\S]*?```|```[\\s\\S]*$",
        options: []
    )
    private static let inlineCodePattern = try! NSRegularExpression(
        pattern: "`[^`\\n]+`",
        options: []
    )

    private static func matches(
        in text: String,
        titleOverrides: [String: String],
        frozenIds: Set<String>
    ) -> [Match] {
        let ns = text as NSString
        let full = NSRange(location: 0, length: ns.length)
        let protected = codeRanges(in: text, fullRange: full)
        var matches: [Match] = []

        for result in idPattern.matches(in: text, range: full) {
            let range = result.range
            guard !protected.contains(where: { NSLocationInRange(range.location, $0) }) else {
                continue
            }
            let id = ns.substring(with: result.range(at: 1))
            guard let name = title(
                for: id,
                overrides: titleOverrides,
                frozenIds: frozenIds
            ) else { continue }
            matches.append(Match(
                id: id,
                range: range,
                name: name,
                // The title alone: the field paints it as a pill, as the
                // web composer does (ComposerQuoteHighlight).
                title: name
            ))
        }

        for result in urlPattern.matches(in: text, range: full) {
            var range = result.range
            let raw = ns.substring(with: range)
            let trimmed = trimURLPunctuation(raw)
            range.length = (trimmed as NSString).length
            guard !trimmed.isEmpty,
                  !protected.contains(where: { NSLocationInRange(range.location, $0) }),
                  let id = sessionId(from: trimmed),
                  let name = title(
                    for: id,
                    overrides: titleOverrides,
                    frozenIds: frozenIds
                  )
            else { continue }
            matches.append(Match(
                id: id,
                range: range,
                name: name,
                // The title alone: the field paints it as a pill, as the
                // web composer does (ComposerQuoteHighlight).
                title: name
            ))
        }

        // SwiftUI's String binding reports the completed value, not the range
        // the platform editor replaced. Two identical labels are therefore
        // ambiguous: deleting the first or second produces the same string.
        // Keep those references raw rather than risk sending the wrong id.
        var nonoverlapping: [Match] = []
        for match in matches.sorted(by: {
            $0.range.location == $1.range.location
                ? $0.range.length > $1.range.length
                : $0.range.location < $1.range.location
        }) where nonoverlapping.last.map({ NSMaxRange($0.range) <= match.range.location }) ?? true {
            nonoverlapping.append(match)
        }
        let titleCounts = Dictionary(grouping: nonoverlapping, by: \.title).mapValues(\.count)
        return nonoverlapping
            .filter { titleCounts[$0.title] == 1 && !text.contains($0.title) }
    }

    private static func title(
        for id: String,
        overrides: [String: String],
        frozenIds: Set<String>
    ) -> String? {
        if let title = overrides[id], !title.isEmpty { return title }
        if frozenIds.contains(id) { return nil }
        guard let title = SessionLinks.title(for: id), !title.isEmpty else { return nil }
        return SessionLinks.cleanTitle(title)
    }

    static func sessionIds(in text: String) -> Set<String> {
        let ns = text as NSString
        let full = NSRange(location: 0, length: ns.length)
        let protected = codeRanges(in: text, fullRange: full)
        var ids: Set<String> = []
        for match in idPattern.matches(in: text, range: full)
            where !protected.contains(where: { NSLocationInRange(match.range.location, $0) }) {
            ids.insert(ns.substring(with: match.range(at: 1)))
        }
        for match in urlPattern.matches(in: text, range: full)
            where !protected.contains(where: { NSLocationInRange(match.range.location, $0) }) {
            let raw = ns.substring(with: match.range)
            if let id = sessionId(from: trimURLPunctuation(raw)) { ids.insert(id) }
        }
        return ids
    }

    private static func codeRanges(in text: String, fullRange: NSRange) -> [NSRange] {
        var ranges = fencePattern.matches(in: text, range: fullRange).map(\.range)
        for match in inlineCodePattern.matches(in: text, range: fullRange) {
            guard !ranges.contains(where: { NSLocationInRange(match.range.location, $0) }) else {
                continue
            }
            ranges.append(match.range)
        }
        return ranges
    }

    private static func sessionId(from value: String) -> String? {
        guard let url = URL(string: value),
              url.scheme == "http" || url.scheme == "https",
              let host = url.host?.lowercased(),
              host == ServerConfig.shared.baseURL?.host?.lowercased()
        else { return nil }
        var path = url.path
        for prefix in ["/opensession", "/backstage"] where path.hasPrefix(prefix + "/") {
            path.removeFirst(prefix.count)
            break
        }
        var parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        if parts.last == "" { parts.removeLast() }
        let id: String?
        if parts.count == 3, parts[0].isEmpty, parts[1] == "session" {
            id = parts[2]
        } else if parts.count == 5, parts[0].isEmpty,
                  parts[1] == "workspace", !parts[2].isEmpty, parts[3] == "session" {
            id = parts[4]
        } else {
            id = nil
        }
        return id?.removingPercentEncoding
    }

    private static func trimURLPunctuation(_ value: String) -> String {
        var out = value
        while let last = out.last, ".,;:!?\"'".contains(last) {
            out.removeLast()
        }
        while out.last == ")", out.filter({ $0 == "(" }).count < out.filter({ $0 == ")" }).count {
            out.removeLast()
        }
        return out
    }
}
