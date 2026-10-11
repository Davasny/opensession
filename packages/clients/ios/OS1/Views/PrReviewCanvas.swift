import SwiftUI

/// Where the canvas gets its data. Live by default; the screenshot fixture and
/// tests hand it canned answers instead.
struct PrReviewLoader {
    var diff: @MainActor () async throws -> PrDiff?
    var viewed: @MainActor (_ number: Int) async throws -> PrViewedFiles
    var setViewed: @MainActor (_ prId: String, _ paths: [String], _ viewed: Bool) async throws -> Void
    var guide: @MainActor () async throws -> PrReviewGuide?
    var flow: @MainActor () async throws -> PrCodeFlow?
    var threads: @MainActor (_ number: Int) async throws -> [PrReviewThread]
    var localStore = PrLocalReviewStore()
    /// Overrides the PR's host capability, for fixtures with no PR details.
    var viewedState: Bool?
    /// Files an earlier load saw, so a fixture can show removed-file history
    /// without two loads. Live loads leave it nil.
    var previousFiles: [String]?

    static func live(sessionId: String, repo: String?) -> PrReviewLoader {
        PrReviewLoader(
            diff: { try await OS1API.prDiff(sessionId: sessionId) },
            viewed: { try await OS1API.prViewedFiles(repo: repo, number: $0) },
            setViewed: { try await OS1API.setPrFilesViewed(prId: $0, paths: $1, viewed: $2, repo: repo) },
            guide: { try await OS1API.prReviewGuide(sessionId: sessionId) },
            flow: { try await OS1API.prCodeFlow(sessionId: sessionId) },
            threads: { try await OS1API.prReviewThreads(repo: repo, number: $0) }
        )
    }
}

/// A native committed-diff review surface. Inline notes remain local until the
/// reviewer submits one GitHub review, matching GitHub's pending-review model.
///
/// The code page carries the same two option menus as the web review canvas.
/// They answer different questions, which is why they stay separate: the lens
/// picks WHAT you are reading (the diff, a guided walk through it, a call
/// graph), and the display settings are how the diff is DRAWN (unified or side
/// by side, long lines wrapped or scrolled). The lens resets per visit; the
/// display settings persist, because a reader picks those once.
///
/// Review progress follows the web: GitHub's viewed state where the host has
/// it (a file a later push changed comes back "changed since review"), marks
/// on this device keyed by each file's diff hash where it does not. The
/// guide's sections are the one grouping of the change, with file types
/// standing in while the guide is written or if it fails.
struct PrReviewCanvas: View {
    let viewModel: SessionViewModel
    private let loader: PrReviewLoader

    /// The lenses the code page can be read through, in menu order.
    enum Lens: String, CaseIterable, Identifiable {
        case all, guide, flow

        var id: String { rawValue }

        var label: String {
            switch self {
            case .all: "All changes"
            case .guide: "Review guide"
            case .flow: "Code flow"
            }
        }

        var symbol: String {
            switch self {
            case .all: "doc.plaintext"
            case .guide: "list.bullet.rectangle"
            case .flow: "arrow.triangle.branch"
            }
        }
    }

    /// The lens lives with the review canvas that frames this page: the tab
    /// row above the diff carries the control, the way the web puts it there
    /// rather than in the header.
    @Binding var lens: Lens
    @State private var diff: PrDiff?
    @State private var files: [PrPatchFile] = []
    /// Path → hash of that file's diff, for marks kept on this device.
    @State private var hashes: [String: String] = [:]
    @State private var marks = PrReviewMarks()
    @State private var removedFiles: PrRemovedFiles?
    @State private var resolvedThreads: [PrReviewThread] = []
    @State private var showResolved = true
    /// Which files have been folded away. Open is the resting state, so this
    /// stays empty until a reader puts something aside.
    @State private var folded = Set<String>()
    @State private var loading = true
    @State private var errorText: String?
    @State private var reviewError: String?
    @State private var draftComments: [PrInlineComment] = []
    @State private var commentTarget: PrLineTarget?
    @State private var submitting = false
    @State private var reviewing = false
    @State private var guide: PrReviewGuide?
    @State private var guideLoading = false
    @State private var guideLoaded = false
    @State private var guideError: String?
    @State private var guideStep = 0
    @State private var guideAllSteps = false
    @State private var flow: PrCodeFlow?
    @State private var flowLoading = false
    @State private var flowError: String?

    init(viewModel: SessionViewModel, lens: Binding<Lens>, loader: PrReviewLoader? = nil) {
        self.viewModel = viewModel
        _lens = lens
        self.loader = loader ?? .live(sessionId: viewModel.session.id, repo: viewModel.session.repo)
    }

    var body: some View {
        Group {
            if loading && diff == nil {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorText, diff == nil {
                ListPlaceholder(
                    symbol: "exclamationmark.triangle",
                    title: "Couldn't load pull request files",
                    message: errorText
                ) {
                    Button("Try again") { Task { await load() } }
                        .buttonStyle(PlaceholderActionStyle())
                }
            } else if files.isEmpty {
                ListPlaceholder(
                    symbol: "doc.text",
                    title: "No committed changes",
                    message: "This pull request has no textual diff to review."
                ) { EmptyView() }
            } else {
                switch lens {
                case .all: fileList
                case .guide: guideList
                case .flow: flowList
                }
            }
        }
        .toolbar {
            // Only what belongs to the pending review itself. The lens and
            // the display settings ride the tab row, and refreshing is the
            // pull the list already answers.
            ToolbarItem(placement: .topTrailingCompat) {
                if submitting {
                    ProgressView().controlSize(.small)
                } else if !draftComments.isEmpty {
                    Button("Finish review") { reviewing = true }
                }
            }
        }
        .task {
            await load()
            #if DEBUG
            // Verification hook: the pending-review sheet with one note in it,
            // without aiming at a diff line first. Once per launch, since a
            // paged TabView can build this page twice.
            if ProcessInfo.processInfo.environment["OS1_OPEN_PR_FINISH_REVIEW"] == "1",
               !PrFinishReviewHook.fired,
               let line = files.first?.lines.first(where: { $0.newLine != nil })?.newLine,
               let path = files.first?.path {
                PrFinishReviewHook.fired = true
                upsertComment(path: path, line: line, text: "Fixture note")
                reviewing = true
            }
            #endif
        }
        .task(id: lens) { await loadLens() }
        .task(id: guidePollKey) { await pollStaleGuide() }
        .sheet(item: $commentTarget) { target in
            PrInlineCommentSheet(target: target) { text in
                upsertComment(path: target.path, line: target.line, text: text)
            }
        }
        .sheet(isPresented: $reviewing) {
            PrPendingReviewSheet(commentCount: draftComments.count) { event, summary in
                try await viewModel.submitPrReview(
                    event: event,
                    summary: summary,
                    comments: draftComments
                )
                draftComments = []
            }
        }
    }

    // MARK: - Derived

    private var paths: [String] { files.map(\.path) }

    private var resolvedByPath: [String: Int] { PrResolvedThreads.countByPath(resolvedThreads) }

    /// The page's one grouping and whether the guide wrote it.
    private var grouping: (groups: [PrReviewGroup], fromGuide: Bool) {
        PrReviewGroups.reviewGroups(guide: guide, paths: paths)
    }

    private func groupProgress(_ grouping: (groups: [PrReviewGroup], fromGuide: Bool)) -> [PrReviewGroupProgress] {
        PrReviewGroups.progress(
            grouping.groups,
            paths: paths,
            reviewed: marks.reviewed,
            changed: marks.changed,
            leftoverTitle: grouping.fromGuide && guide?.stale == true
                ? PrReviewGroups.staleLeftoverTitle
                : PrReviewGroups.leftoverTitle
        )
    }

    private var isLocalReview: Bool {
        if case .local = marks.source { return true }
        return false
    }

    private var reviewedCount: Int { paths.filter(marks.reviewed.contains).count }
    private var changedCount: Int { paths.filter(marks.changed.contains).count }

    /// One file's diff. Built here rather than through a
    /// `navigationDestination(for:)`: this canvas is a PAGE of the review
    /// panel now, not a pushed view of its own, and a value-based link needs
    /// its destination registered on the stack that owns it — which left a
    /// tapped file merely selected. A view-based link needs no registration.
    private func fileView(_ file: PrPatchFile) -> some View {
        PrReviewFileView(
            file: file,
            reviewState: marks.isAvailable ? marks.state(of: file.path) : nil,
            commentCount: draftComments.filter { $0.path == file.path }.count,
            toggleViewed: { toggleViewed(file.path) },
            comment: { line in commentTarget = PrLineTarget(path: file.path, line: line) }
        )
    }

    // MARK: - Shared chrome

    /// Progress, the changed-since-review callout, pending notes and the
    /// resolved-comment filter: the same block on top of both diff lenses.
    @ViewBuilder
    private func reviewChrome(order: [String], scroll: @escaping (String) -> Void) -> some View {
        if marks.isAvailable {
            PrReviewProgressHeader(
                total: files.count,
                reviewed: reviewedCount,
                changed: changedCount,
                nextUnreviewed: {
                    if let next = PrReviewGroups.nextUnreviewed(order, after: nil, reviewed: marks.reviewed) {
                        scroll(next)
                    }
                },
                bulk: { bulk($0, paths: paths) }
            )
            .padding(.horizontal, 4)
        } else {
            HStack {
                Text("\(files.count) file\(files.count == 1 ? "" : "s") changed")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(OS1VisualStyle.textDim)
                Spacer(minLength: 8)
                changeCounts
            }
            .padding(.horizontal, 4)
        }

        if changedCount > 0 {
            PrReviewCallout(
                tone: .warning,
                symbol: "exclamationmark.arrow.circlepath",
                title: "\(changedCount) file\(changedCount == 1 ? "" : "s") changed since you reviewed \(changedCount == 1 ? "it" : "them")",
                message: isLocalReview
                    ? "These files were edited after you marked them reviewed. Read them again."
                    : "Commits pushed after your review changed these files. Read them again."
            ) {
                if let first = order.first(where: marks.changed.contains) {
                    Button("Show first changed file") { scroll(first) }
                        .font(.caption.weight(.medium))
                        .buttonStyle(.borderless)
                        .padding(.top, 2)
                }
            }
        }

        if let reviewError {
            Text(reviewError)
                .font(.caption)
                .foregroundStyle(OS1VisualStyle.redInk)
                .padding(.horizontal, 4)
        }

        if draftComments.isEmpty {
            Text("Tap a line number to comment on that line.")
                .font(.caption)
                .foregroundStyle(OS1VisualStyle.textFaint)
                .padding(.horizontal, 4)
        }

        let resolvedCount = resolvedThreads.count
        if !draftComments.isEmpty || resolvedCount > 0 {
            HStack(spacing: 10) {
                if !draftComments.isEmpty {
                    Text("\(draftComments.count) pending inline comment\(draftComments.count == 1 ? "" : "s") · saved locally until you submit one review")
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.yellowInk)
                }
                Spacer(minLength: 0)
                if resolvedCount > 0 {
                    Button(showResolved ? "Hide resolved comments" : "Show \(resolvedCount) resolved") {
                        showResolved.toggle()
                    }
                    .font(.caption.weight(.medium))
                    .buttonStyle(.borderless)
                }
            }
            .padding(.horizontal, 4)
        }
    }

    @ViewBuilder
    private var trailingSections: some View {
        if let removed = removedFiles?.removed, !removed.isEmpty {
            PrRemovedFilesSection(paths: removed)
        }
        if let skipped = diff?.skippedFiles, skipped > 0 {
            Text("\(skipped) file\(skipped == 1 ? " was" : "s were") omitted because the patch is too large.")
                .font(.caption)
                .foregroundStyle(OS1VisualStyle.textDim)
                .padding(.horizontal, 4)
        }
    }

    // MARK: - All changes

    private var fileList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    reviewChrome(order: paths) { path in
                        folded.remove(path)
                        withAnimation { proxy.scrollTo(path, anchor: .top) }
                    }
                    ForEach(files) { file in
                        fileCard(file).id(file.path)
                    }
                    trailingSections
                }
                .padding(16)
            }
        }
        .background(OS1VisualStyle.background)
        .refreshable { await reload() }
    }

    /// One file, open: its name and size on a header, its diff in the card
    /// under it. Open is the resting state, because a page of file names is
    /// not a review; folding is for putting a file you have read out of the
    /// way, and the card is what tells one file's lines from the next one's.
    /// A file changed since review wears an amber edge and says so in words.
    @ViewBuilder
    private func fileCard(_ file: PrPatchFile) -> some View {
        let isOpen = !folded.contains(file.path)
        let state = marks.state(of: file.path)
        let resolved = resolvedByPath[file.path] ?? 0
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                // Marking a file read is its own target, so folding it away
                // never claims you read it.
                if marks.isAvailable {
                    PrReviewStateButton(state: state) { toggleViewed(file.path) }
                }

                Button {
                    if isOpen { folded.insert(file.path) } else { folded.remove(file.path) }
                } label: {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(fileName(file.path))
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(OS1VisualStyle.text)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            if let folder = fileFolder(file.path) {
                                Text(folder)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(OS1VisualStyle.textDim)
                                    .lineLimit(1)
                                    .truncationMode(.head)
                            }
                            if state == .changed || resolved > 0 {
                                // Side by side where they fit, stacked on a phone.
                                ViewThatFits(in: .horizontal) {
                                    HStack(spacing: 6) { fileMarks(state: state, resolved: resolved) }
                                    VStack(alignment: .leading, spacing: 4) { fileMarks(state: state, resolved: resolved) }
                                }
                                .padding(.top, 2)
                            }
                        }
                        Spacer(minLength: 8)
                        fileCounts(file)
                        Image(systemName: "chevron.down")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .rotationEffect(.degrees(isOpen ? 0 : -90))
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                NavigationLink { fileView(file) } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open \(file.path) on its own")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .contextMenu { reviewMenu(for: file.path) }

            if isOpen {
                Divider()
                let notes = draftComments.filter { $0.path == file.path }.count
                if notes > 0 {
                    HStack {
                        Text("\(notes) pending comment\(notes == 1 ? "" : "s")")
                            .font(.caption)
                            .foregroundStyle(OS1VisualStyle.yellowInk)
                        Spacer()
                    }
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                }
                if showResolved, resolved > 0 {
                    PrResolvedThreadsList(threads: resolvedThreads.filter { $0.path == file.path })
                }
                PrFileDiffBody(
                    file: file,
                    comment: { line in
                        commentTarget = PrLineTarget(path: file.path, line: line)
                    }
                )
                .padding(.vertical, 8)
            }
        }
        .background(OS1VisualStyle.raised)
        // Clipped, not just filled: the diff's own washes run the full width
        // of the line, and unclipped they square off the card's corners.
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            if state == .changed {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(OS1VisualStyle.yellow.opacity(0.7), lineWidth: 1.5)
            }
        }
        // A read file steps back rather than disappearing: it is still part of
        // the change, it just is not what you are looking for any more.
        .opacity(state == .reviewed && !isOpen ? 0.6 : 1)
    }

    @ViewBuilder
    private func fileMarks(state: PrFileReviewState, resolved: Int) -> some View {
        if state == .changed { PrChangedSinceReviewBadge().fixedSize() }
        if resolved > 0 {
            Label("\(resolved) resolved", systemImage: "checkmark.bubble")
                .font(.caption2)
                .foregroundStyle(OS1VisualStyle.textDim)
                .lineLimit(1)
                .fixedSize()
        }
    }

    /// The file's and its folder's review actions, on a long press.
    @ViewBuilder
    private func reviewMenu(for path: String) -> some View {
        if marks.isAvailable {
            let reviewed = marks.reviewed.contains(path)
            Button {
                setReviewed([path], reviewed: !reviewed)
            } label: {
                Label(reviewed ? "Mark file as not reviewed" : "Mark file as reviewed",
                      systemImage: reviewed ? "circle" : "checkmark.circle")
            }
            if let folder = PrReviewGroups.folder(of: path) {
                let targets = PrReviewGroups.filesInFolder(paths, folder: folder)
                let allReviewed = targets.allSatisfy(marks.reviewed.contains)
                Button {
                    setReviewed(targets, reviewed: !allReviewed)
                } label: {
                    Label(
                        allReviewed
                            ? "Mark folder as not reviewed (\(targets.count))"
                            : "Mark folder as reviewed (\(targets.count))",
                        systemImage: "folder"
                    )
                }
            }
        }
    }

    /// The file's own name carries the weight; the folder above it is context.
    private func fileName(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    private func fileFolder(_ path: String) -> String? {
        let parts = path.split(separator: "/")
        guard parts.count > 1 else { return nil }
        return parts.dropLast().joined(separator: "/")
    }

    /// How much of the change is this file's, counted from its own lines.
    private func fileCounts(_ file: PrPatchFile) -> some View {
        let added = file.lines.filter { $0.kind == .addition }.count
        let removed = file.lines.filter { $0.kind == .deletion }.count
        return HStack(spacing: 5) {
            Text("+\(added)").foregroundStyle(OS1VisualStyle.greenInk)
            Text("−\(removed)").foregroundStyle(OS1VisualStyle.redInk)
        }
        .font(.caption2.monospacedDigit())
    }

    /// How big the change is, beside the count of files it touches — the same
    /// pair the web puts in the code page's chrome row.
    @ViewBuilder
    private var changeCounts: some View {
        if let pr = viewModel.prDetails {
            HStack(spacing: 5) {
                Text("+\(pr.additions ?? 0)").foregroundStyle(OS1VisualStyle.greenInk)
                Text("−\(pr.deletions ?? 0)").foregroundStyle(OS1VisualStyle.redInk)
            }
            .font(.caption.monospacedDigit())
        }
    }

    // MARK: - Review guide

    /// The guide, one step at a time by default, so a large PR is a few
    /// focused passes rather than one long scroll. Until it is written (or if
    /// it fails) the same steps are file types, so the page is useful at once.
    private var guideList: some View {
        let grouping = grouping
        let groups = groupProgress(grouping)
        let stepping = !guideAllSteps && groups.count > 1
        let current = min(guideStep, max(0, groups.count - 1))
        let order = groups.flatMap(\.files)
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    guideHeader(groups: groups, fromGuide: grouping.fromGuide, stepping: stepping, current: current, proxy: proxy)
                    reviewChrome(order: order) { path in
                        if stepping, let step = groups.firstIndex(where: { $0.files.contains(path) }), step != current {
                            guideStep = step
                        }
                        folded.remove(path)
                        Task { @MainActor in
                            await Task.yield()
                            withAnimation { proxy.scrollTo(path, anchor: .top) }
                        }
                    }
                    ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
                        if !stepping || index == current {
                            PrReviewGroupHeader(
                                index: index,
                                count: groups.count,
                                group: group,
                                setReviewed: marks.isAvailable ? { setReviewed(group.files, reviewed: $0) } : nil
                            )
                            .padding(.top, index == current || !stepping ? 6 : 0)
                            .id("step-\(index)")
                            ForEach(group.files, id: \.self) { path in
                                if let file = files.first(where: { $0.path == path }) {
                                    fileCard(file).id(path)
                                }
                            }
                        }
                    }
                    guideFooter(groups: groups, stepping: stepping, current: current, proxy: proxy)
                    trailingSections
                }
                .padding(16)
            }
        }
        .background(OS1VisualStyle.background)
        .refreshable { await reload() }
    }

    @ViewBuilder
    private func guideHeader(
        groups: [PrReviewGroupProgress],
        fromGuide: Bool,
        stepping: Bool,
        current: Int,
        proxy: ScrollViewProxy
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(fromGuide ? "Review guide" : "Grouped by file type")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.textDim)
                    Text("\(groups.count) focused review step\(groups.count == 1 ? "" : "s")")
                        .font(.headline)
                        .foregroundStyle(OS1VisualStyle.text)
                }
                Spacer(minLength: 8)
                if groups.count > 1 {
                    Picker("Guide layout", selection: $guideAllSteps) {
                        Text("One step").tag(false)
                        Text("All steps").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                }
            }

            if fromGuide, guide?.stale == true {
                PrReviewCallout(
                    tone: .warning,
                    symbol: "clock.badge.exclamationmark",
                    title: "Outdated guide",
                    message: "Written before the latest commits. Updating to cover them. Files the new commits added are under “\(PrReviewGroups.staleLeftoverTitle)”."
                )
            } else if !fromGuide && (guideLoading || !guideLoaded) {
                PrReviewCallout(
                    tone: .info,
                    symbol: "sparkles",
                    title: "Writing the review guide",
                    message: "Files are grouped by type until it groups the change by intent."
                )
            } else if !fromGuide {
                PrReviewCallout(
                    tone: .info,
                    symbol: "exclamationmark.triangle",
                    title: "No review guide",
                    message: guideError.map { "Couldn't write a guide for this PR (\($0)). Files are grouped by type instead." }
                        ?? "Couldn't write a guide for this PR. Files are grouped by type instead."
                ) {
                    Button("Try again") {
                        Task {
                            guide = nil
                            guideLoaded = false
                            await loadLens()
                        }
                    }
                    .font(.caption.weight(.medium))
                    .buttonStyle(.borderless)
                    .padding(.top, 2)
                }
            }

            if stepping {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
                            PrGuideStepChip(
                                index: index,
                                group: group,
                                isCurrent: index == current,
                                showsProgress: marks.isAvailable
                            ) {
                                showStep(index, proxy: proxy)
                            }
                        }
                    }
                }
                .accessibilityLabel("Guide steps")
            }
        }
        .padding(.horizontal, 4)
        .id("guide-top")
    }

    @ViewBuilder
    private func guideFooter(
        groups: [PrReviewGroupProgress],
        stepping: Bool,
        current: Int,
        proxy: ScrollViewProxy
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if stepping && current < groups.count - 1 {
                Button {
                    showStep(current + 1, proxy: proxy)
                } label: {
                    Label("Next: \(groups[current + 1].title)", systemImage: "chevron.right")
                        .lineLimit(1)
                }
                .buttonStyle(.borderedProminent)
                if marks.isAvailable {
                    Button("Mark step reviewed and continue") {
                        setReviewed(groups[current].files.filter { !marks.reviewed.contains($0) }, reviewed: true)
                        showStep(current + 1, proxy: proxy)
                    }
                    .buttonStyle(.bordered)
                }
            } else {
                Label("You've reached the end of the guide.", systemImage: "flag.checkered")
                    .font(.subheadline)
                    .foregroundStyle(OS1VisualStyle.textDim)
                if !draftComments.isEmpty {
                    Button("Finish review (\(draftComments.count))") { reviewing = true }
                        .buttonStyle(.borderedProminent)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
        .padding(.top, 6)
    }

    private func showStep(_ step: Int, proxy: ScrollViewProxy) {
        guideStep = step
        Task { @MainActor in
            await Task.yield()
            withAnimation { proxy.scrollTo("guide-top", anchor: .top) }
        }
    }

    // MARK: - Code flow

    @ViewBuilder
    private var flowList: some View {
        if flowLoading && flow == nil {
            ProgressView("Tracing the change")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let flow, !flow.trees.isEmpty {
            List {
                ForEach(flow.trees) { tree in
                    Section {
                        ForEach(PrCodeFlowRow.rows(of: tree.tree)) { row in
                            flowRow(row)
                        }
                    } header: {
                        Text(tree.entry).font(.caption.monospaced())
                    }
                }
                if flow.truncated == true {
                    Section {
                        Text("The graph was cut short because the change is large.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .insetGroupedListCompat()
            .refreshable { await reload() }
        } else {
            ListPlaceholder(
                symbol: "arrow.triangle.branch",
                title: "No code flow",
                message: flowError
                    ?? "This change has no traced call graph. Read it as a diff instead."
            ) {
                Button("All changes") { lens = .all }
                    .buttonStyle(PlaceholderActionStyle())
            }
        }
    }

    private func flowRow(_ row: PrCodeFlowRow) -> some View {
        HStack(spacing: 8) {
            Color.clear.frame(width: CGFloat(row.depth) * 12, height: 1)
            Text(row.node.mark)
                .font(.caption.monospaced().bold())
                .foregroundStyle(flowTone(row.node.status))
                .frame(width: 10)
            Text(row.node.label)
                .font(.caption.monospaced())
                .foregroundStyle(flowTone(row.node.status))
                .lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 6)
            if let path = row.node.file, let file = files.first(where: { $0.path == path }) {
                NavigationLink {
                    fileView(file)
                } label: {
                    Text(shortPath(path))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1).truncationMode(.head)
                }
                .buttonStyle(.plain)
                .frame(maxWidth: 140, alignment: .trailing)
            }
        }
    }

    private func flowTone(_ status: String) -> Color {
        switch status {
        case "added": OS1VisualStyle.greenInk
        case "removed": OS1VisualStyle.redInk
        case "modified": .orange
        default: .secondary
        }
    }

    private func shortPath(_ path: String) -> String {
        let parts = path.split(separator: "/")
        return parts.count > 2 ? parts.suffix(2).joined(separator: "/") : path
    }

    // MARK: - Loading

    /// Where review marks live for this PR: GitHub's viewed state unless the
    /// host says it has none.
    private var hostHasViewedState: Bool {
        loader.viewedState ?? (viewModel.prDetails?.capabilities?.viewedState != false)
    }

    private func load() async {
        loading = true
        errorText = nil
        do {
            guard let patch = try await loader.diff() else {
                diff = nil
                files = []
                loading = false
                return
            }
            let (parsed, fileHashes) = await Task.detached(priority: .userInitiated) {
                let parsed = PrPatchParser.files(in: patch.patch)
                return (parsed, PrReviewHash.hashes(of: parsed))
            }.value
            diff = patch
            files = parsed
            hashes = fileHashes
            let target = "\(viewModel.session.repo ?? "pr")#\(patch.number)"
            let previous = removedFiles ?? loader.previousFiles.map {
                PrRemovedFiles(target: target, known: $0, removed: [])
            }
            removedFiles = PrRemovedFiles.next(previous, target: target, current: parsed.map(\.path))
            await loadMarks(number: patch.number)
            resolvedThreads = (try? await loader.threads(patch.number)) ?? []
        } catch {
            errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        loading = false
    }

    /// GitHub's viewed and changed-since-viewed files, refetched with the diff
    /// so a push shows up as changed. A host without viewed state keeps marks
    /// on this device instead, checked against each file's diff hash.
    private func loadMarks(number: Int) async {
        if hostHasViewedState {
            if let state = try? await loader.viewed(number) {
                marks = .github(state)
            }
        } else {
            let key = PrLocalReviewStore.pullRequestKey(repo: viewModel.session.repo, number: number)
            marks = .local(key: key, stored: loader.localStore.read(key), hashes: hashes)
        }
    }

    /// Reload the diff and whatever lens is on screen, so pull-to-refresh means
    /// the same thing on all three pages.
    private func reload() async {
        await load()
        if lens == .guide { guide = nil; guideLoaded = false }
        flow = lens == .flow ? nil : flow
        await loadLens()
    }

    /// Each lens loads on first use, not with the canvas: the guide is a
    /// per-commit model call and the flow parses source, and a reader who only
    /// wants the diff should pay for neither.
    private func loadLens() async {
        switch lens {
        case .all:
            return
        case .guide:
            guard guide == nil, !guideLoading else { return }
            guideLoading = true
            guideError = nil
            do {
                guide = try await loader.guide()
            } catch {
                guideError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            guideLoading = false
            guideLoaded = true
        case .flow:
            guard flow == nil, !flowLoading else { return }
            flowLoading = true
            flowError = nil
            do {
                flow = try await loader.flow()
            } catch {
                flowError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            flowLoading = false
        }
    }

    private var guidePollKey: String {
        lens == .guide && guide?.stale == true ? "stale:\(guide?.headRefOid ?? "")" : ""
    }

    /// After a push the server answers at once with the previous guide marked
    /// stale and updates it in the background. Ask again until the update
    /// lands, for a few minutes at most, as the web does.
    private func pollStaleGuide() async {
        guard !guidePollKey.isEmpty else { return }
        for _ in 0..<12 {
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled else { return }
            guard let next = try? await loader.guide() else { continue }
            guide = next
            if !next.stale { return }
        }
    }

    // MARK: - Review marks

    private func toggleViewed(_ path: String) {
        setReviewed([path], reviewed: !marks.reviewed.contains(path))
    }

    private func bulk(_ action: PrReviewBulkAction, paths targets: [String]) {
        let change = PrReviewGroups.bulkChanges(targets, reviewed: marks.reviewed, action: action)
        setReviewed(change.mark, reviewed: true)
        setReviewed(change.unmark, reviewed: false)
    }

    /// Mark or unmark many files in one request. GitHub changes are applied
    /// at once and put back if GitHub refuses; local marks save immediately.
    private func setReviewed(_ targets: [String], reviewed next: Bool) {
        guard !targets.isEmpty else { return }
        reviewError = nil
        switch marks.source {
        case .unavailable:
            return
        case .local(let key):
            let stored = loader.localStore.setReviewed(key, paths: targets, reviewed: next, hashes: hashes)
            marks = .local(key: key, stored: stored, hashes: hashes)
        case .github(let prId):
            let previous = marks
            marks.apply(targets, reviewed: next)
            Task {
                do {
                    try await loader.setViewed(prId, targets, next)
                } catch {
                    if marks.source == previous.source { marks = previous }
                    reviewError = "Couldn't update review progress on GitHub."
                }
            }
        }
    }

    private func upsertComment(path: String, line: Int, text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let comment = PrInlineComment(path: path, line: line, text: trimmed)
        draftComments.removeAll { $0.id == comment.id }
        draftComments.append(comment)
    }
}

/// One flattened node of a code-flow tree. The web draws the tree fully
/// expanded, so this flattens rather than collapsing behind disclosure rows.
struct PrCodeFlowRow: Identifiable {
    let id: String
    let node: PrCodeFlowNode
    let depth: Int

    static func rows(of root: PrCodeFlowNode) -> [PrCodeFlowRow] {
        var rows: [PrCodeFlowRow] = []
        func walk(_ node: PrCodeFlowNode, depth: Int, path: String) {
            let id = "\(path)/\(node.key):\(node.status)"
            rows.append(PrCodeFlowRow(id: id, node: node, depth: depth))
            for (index, child) in node.children.enumerated() {
                walk(child, depth: depth + 1, path: "\(id).\(index)")
            }
        }
        walk(root, depth: 0, path: "")
        return rows
    }
}

/// The lens picker, and the display settings for the lenses that draw a diff.
/// The settings live in app storage rather than view state so they survive
/// leaving the canvas, and so the file view below reads the same values.
struct PrViewOptionsMenu: View {
    @Binding var lens: PrReviewCanvas.Lens
    var showsDiffDisplay = true

    @AppStorage(PrDiffDisplay.styleKey) private var styleRaw = ""
    @AppStorage(PrDiffDisplay.wrapKey) private var wrapLines = false
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        Menu {
            Picker("View", selection: $lens) {
                ForEach(PrReviewCanvas.Lens.allCases) { option in
                    Label(option.label, systemImage: option.symbol).tag(option)
                }
            }
            .pickerStyle(.inline)

            if showsDiffDisplay {
                Section {
                    Picker("Diff display", selection: styleBinding) {
                        ForEach(PrDiffStyle.allCases, id: \.self) { style in
                            Label(style.label, systemImage: style.symbol).tag(style)
                        }
                    }
                    .pickerStyle(.inline)
                    Toggle(isOn: $wrapLines) {
                        Label("Wrap long lines", systemImage: "text.append")
                    }
                }
            }
        } label: {
            Label("View options", systemImage: "slider.horizontal.3")
        }
    }

    private var styleBinding: Binding<PrDiffStyle> {
        Binding(
            get: { PrDiffDisplay.style(styleRaw, sizeClass: sizeClass) },
            set: { styleRaw = $0.rawValue }
        )
    }
}

/// Where the display settings are stored, and what an unset value means.
enum PrDiffDisplay {
    static let styleKey = "os1.pr.diffStyle"
    static let wrapKey = "os1.pr.wrapLines"

    /// Side-by-side columns don't fit a phone, so a reader who has never
    /// picked gets unified there and split where there is room — the same
    /// default the web applies at its phone breakpoint.
    static func style(_ raw: String, sizeClass: UserInterfaceSizeClass?) -> PrDiffStyle {
        if let stored = PrDiffStyle(rawValue: raw) { return stored }
        return sizeClass == .regular ? .split : .unified
    }
}

/// A file's diff. The same body whether it is folded open inside the list or
/// filling a pushed screen, so the two can never drift apart.
///
/// Wrapped lines have nowhere to scroll sideways, so wrapping drops the
/// horizontal axis entirely rather than leaving a scroll view that never
/// moves.
///
/// Inline, lines ALWAYS wrap, whatever the reader picked. A card in a stack
/// of files has no room for a second axis, and a horizontal scroll view there
/// swallows the swipe that moves between the canvas's pages — you could swipe
/// into Files and not back out. The full-screen file keeps both axes and
/// honours the setting, which is what it is for.
struct PrFileDiffBody: View {
    let file: PrPatchFile
    let comment: (Int) -> Void
    /// Inline, the enclosing list scrolls vertically and this must not.
    var inline = true

    @AppStorage(PrDiffDisplay.styleKey) private var styleRaw = ""
    @AppStorage(PrDiffDisplay.wrapKey) private var wrapLines = false
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var viewportHeight: CGFloat = 0

    private var style: PrDiffStyle { PrDiffDisplay.style(styleRaw, sizeClass: sizeClass) }

    var body: some View {
        if inline {
            lines
        } else if wrapLines {
            ScrollView(.vertical) { lines.padding(.vertical, 8) }
        } else {
            // A two-axis scroll view centres content smaller than itself, which
            // parks a short file in the middle of the screen. The min height
            // pins it to the top instead.
            ScrollView([.horizontal, .vertical]) {
                lines
                    .frame(minWidth: style == .split ? 1040 : 680, alignment: .leading)
                    .frame(minHeight: viewportHeight, alignment: .top)
                    .padding(.vertical, 8)
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewportHeight = $0 }
        }
    }

    @ViewBuilder
    private var lines: some View {
        let wraps = inline || wrapLines
        LazyVStack(alignment: .leading, spacing: 0) {
            if style == .split {
                ForEach(PrPatchParser.rows(file.lines)) { row in
                    PrReviewSplitRowView(row: row, wraps: wraps, comment: comment)
                }
            } else {
                ForEach(file.lines) { line in
                    PrReviewLineView(line: line, wraps: wraps, comment: comment)
                }
            }
        }
    }
}

private struct PrReviewFileView: View {
    let file: PrPatchFile
    /// Nil when this review has no marks to show.
    let reviewState: PrFileReviewState?
    let commentCount: Int
    let toggleViewed: () -> Void
    let comment: (Int) -> Void

    var body: some View {
        PrFileDiffBody(file: file, comment: comment, inline: false)
            .background(OS1VisualStyle.background)
            .navigationTitle(file.path.split(separator: "/").last.map(String.init) ?? file.path)
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .topTrailingCompat) {
                    PrDiffDisplayMenu()
                }
                if let reviewState {
                    ToolbarItem(placement: .topTrailingCompat) {
                        Button(action: toggleViewed) {
                            Label(
                                reviewState == .reviewed ? "Mark not reviewed" : "Mark reviewed",
                                systemImage: reviewState == .reviewed ? "checkmark.circle.fill" : "checkmark.circle"
                            )
                        }
                    }
                }
            }
            .safeAreaInset(edge: .top) {
                if reviewState == .changed {
                    PrChangedSinceReviewBadge().padding(.top, 6)
                }
            }
            .safeAreaInset(edge: .bottom) {
                if commentCount > 0 {
                    Text("\(commentCount) pending inline comment\(commentCount == 1 ? "" : "s")")
                        .font(.caption.weight(.medium))
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(.thinMaterial, in: Capsule())
                        .padding(.bottom, 8)
                }
            }
    }

}

/// The display half of the canvas' options, repeated on the file itself: a
/// reader who decides mid-file that they want side by side shouldn't have to
/// walk back out to say so.
private struct PrDiffDisplayMenu: View {
    @AppStorage(PrDiffDisplay.styleKey) private var styleRaw = ""
    @AppStorage(PrDiffDisplay.wrapKey) private var wrapLines = false
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        Menu {
            Picker("Diff display", selection: styleBinding) {
                ForEach(PrDiffStyle.allCases, id: \.self) { style in
                    Label(style.label, systemImage: style.symbol).tag(style)
                }
            }
            .pickerStyle(.inline)
            Toggle(isOn: $wrapLines) {
                Label("Wrap long lines", systemImage: "text.append")
            }
        } label: {
            Label("Diff display", systemImage: "slider.horizontal.3")
        }
    }

    private var styleBinding: Binding<PrDiffStyle> {
        Binding(
            get: { PrDiffDisplay.style(styleRaw, sizeClass: sizeClass) },
            set: { styleRaw = $0.rawValue }
        )
    }
}

private struct PrReviewLineView: View {
    let line: PrPatchLine
    var wraps = false
    let comment: (Int) -> Void

    /// Wide enough for four digits at the gutter's size. Two of these and a
    /// comment button used to take a third of a phone's width from the code.
    private static let gutterWidth: CGFloat = 32

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            // The gutter is the comment target, the way a tapped line number
            // starts one on the web: no button column on every line.
            gutter
            // Wrapped: the line takes the width it is given and grows down.
            // Unwrapped: it takes its own full width and the page scrolls
            // sideways to it, which is what "wrap long lines" turns off.
            Text(line.text.isEmpty ? " " : line.text)
                .font(.system(.caption, design: .monospaced))
                .lineLimit(wraps ? nil : 1)
                .fixedSize(horizontal: !wraps, vertical: true)
                .frame(maxWidth: wraps ? .infinity : nil, alignment: .leading)
                .padding(.leading, 6)
                .padding(.trailing, 4)
                .textSelection(.enabled)
            if !wraps { Spacer(minLength: 0) }
        }
        .foregroundStyle(PrDiffInk.foreground(line.kind))
        .background(PrDiffInk.background(line.kind))
        .accessibilityElement(children: .combine)
        .accessibilityActions {
            if let anchor = line.commentLine {
                Button("Add inline comment on line \(anchor)") { comment(anchor) }
            }
        }
    }

    @ViewBuilder
    private var gutter: some View {
        let numbers = HStack(spacing: 0) {
            Text(line.oldLine.map(String.init) ?? "")
                .frame(width: Self.gutterWidth, alignment: .trailing)
            Text(line.newLine.map(String.init) ?? "")
                .frame(width: Self.gutterWidth, alignment: .trailing)
        }
        .font(.system(.caption2, design: .monospaced))
        .foregroundStyle(PrDiffInk.foreground(line.kind).opacity(0.6))
        if let anchor = line.commentLine {
            Button { comment(anchor) } label: {
                numbers.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHidden(true)
        } else {
            numbers
        }
    }
}

/// One row of the side-by-side diff: the old side and the new side of the same
/// change, with the comment anchor on the right where GitHub accepts it.
private struct PrReviewSplitRowView: View {
    let row: PrPatchRow
    var wraps = false
    let comment: (Int) -> Void

    var body: some View {
        if let header = row.header {
            Text(header.text)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(PrDiffInk.foreground(.metadata))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 10)
                .background(PrDiffInk.background(.metadata))
        } else {
            HStack(spacing: 0) {
                side(row.left, number: row.left?.oldLine)
                Rectangle()
                    .fill(OS1VisualStyle.border)
                    .frame(width: 1)
                side(row.right, number: row.right?.newLine, anchor: row.right?.commentLine)
            }
            .font(.system(.caption, design: .monospaced))
            .textSelection(.enabled)
        }
    }

    private func side(_ line: PrPatchLine?, number: Int?, anchor: Int? = nil) -> some View {
        HStack(spacing: 0) {
            Text(number.map(String.init) ?? "")
                .frame(width: 40, alignment: .trailing)
            // Both columns keep the same width so the two sides of a change
            // stay on one line together; a line too long for its column is
            // what "wrap long lines" is for.
            Text((line?.text).flatMap { $0.isEmpty ? " " : $0 } ?? " ")
                .lineLimit(wraps ? nil : 1)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 8)
            if let anchor {
                Button { comment(anchor) } label: {
                    Image(systemName: "plus.bubble")
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 6)
                .accessibilityLabel("Add inline comment on line \(anchor)")
            } else {
                Color.clear.frame(width: 26)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .foregroundStyle(PrDiffInk.foreground(line?.kind ?? .context))
        .background(PrDiffInk.background(line?.kind ?? .context))
    }
}

/// One definition of diff ink, shared by the unified and split renderers so
/// the two can't drift.
private enum PrDiffInk {
    static func foreground(_ kind: PrPatchLine.Kind) -> Color {
        switch kind {
        case .addition: OS1VisualStyle.greenInk
        case .deletion: OS1VisualStyle.redInk
        case .metadata: OS1VisualStyle.blueInk
        case .context: OS1VisualStyle.codeWellText
        }
    }

    static func background(_ kind: PrPatchLine.Kind) -> Color {
        switch kind {
        case .addition: OS1VisualStyle.green.opacity(0.10)
        case .deletion: OS1VisualStyle.red.opacity(0.10)
        default: .clear
        }
    }
}

#if DEBUG
@MainActor
private enum PrFinishReviewHook {
    static var fired = false
}
#endif

private struct PrLineTarget: Identifiable {
    let path: String
    let line: Int
    var id: String { "\(path):\(line)" }
}

private struct PrInlineCommentSheet: View {
    let target: PrLineTarget
    let save: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("\(target.path):\(target.line)").font(.caption.monospaced())
                }
                Section("Comment") {
                    TextEditor(text: $text).frame(minHeight: 140).focused($focused)
                }
            }
            .navigationTitle("Inline comment")
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .topLeadingCompat) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .topTrailingCompat) {
                    Button("Add") { save(text); dismiss() }
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .task { focused = true }
        #if os(macOS)
        .frame(minWidth: 440, minHeight: 360)
        #endif
    }
}

private struct PrPendingReviewSheet: View {
    let commentCount: Int
    let submit: (String, String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var event = "COMMENT"
    @State private var summary = ""
    @State private var gate = ReviewSubmitGate()
    @State private var errorText: String?

    private var sending: Bool { gate.inFlight }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("\(commentCount) inline comment\(commentCount == 1 ? "" : "s") will be submitted together.")
                }
                Section {
                    Picker("Review", selection: $event) {
                        Text("Comment").tag("COMMENT")
                        Text("Approve").tag("APPROVE")
                        Text("Request changes").tag("REQUEST_CHANGES")
                    }.pickerStyle(.segmented).labelsHidden()
                }
                Section("Summary") { TextEditor(text: $summary).frame(minHeight: 110) }
                if let errorText { Section { Text(errorText).foregroundStyle(.red) } }
            }
            .navigationTitle("Submit review")
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .sheetCancelCompat) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .sheetConfirmCompat) {
                    if sending { ProgressView().controlSize(.small) } else {
                        Button("Submit") { send() }.noDefaultReturnKey()
                    }
                }
            }
            .disabled(sending)
            .reviewSubmitShortcut(enabled: !sending) { send(viaKeyboard: true) }
        }
        #if os(macOS)
        .frame(minWidth: 440, minHeight: 400)
        #endif
    }

    /// The Submit button and Cmd+Enter both land here. Submit is always
    /// enabled: the inline comments are the review, so an empty summary still
    /// posts them. Only the chord defers to an input method's marked text.
    private func send(viaKeyboard: Bool = false) {
        let composing = viaKeyboard && TextComposition.isActive
        guard gate.begin(enabled: true, composing: composing) else { return }
        errorText = nil
        Task {
            do {
                try await submit(event, summary)
                dismiss()
            } catch {
                errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            gate.finish()
        }
    }
}
