import SwiftUI

/// A ```compare fence: two stills as one before/after control. The before
/// still underneath, the after still clipped to the right of a divider, and
/// a sideways drag or a tap anywhere moves the divider. A vertical swipe that
/// starts on the stills still scrolls the transcript, and a tall pair is
/// capped in height so it never fills the screen. Both stills load with the
/// session's credentials the way every transcript picture does.
struct CompareSliderView: View {
    /// The tallest the box gets; a portrait pair shrinks in width to fit.
    private static let maxHeight: CGFloat = 400

    let spec: CompareSpec

    @Environment(\.transcriptSessionId) private var sessionId
    @Environment(\.openPanel) private var openPanel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var before: Data?
    @State private var after: Data?
    @State private var failed = false
    @State private var position: CGFloat = 0.5
    @State private var expanded = false

    private var resolvedSessionId: String { openPanel.sessionId ?? sessionId ?? "" }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Group {
                if let before, let after {
                    slider(before: before, after: after)
                } else if failed {
                    placeholder(symbol: "photo.badge.exclamationmark")
                } else {
                    placeholder(symbol: nil)
                }
            }
            .clipShape(BlockChrome.shape)
            .overlay {
                BlockChrome.shape.stroke(OS1VisualStyle.border.opacity(0.6), lineWidth: 0.5)
            }
            if let caption = spec.caption {
                Text(caption)
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .task(id: spec) {
            failed = false
            async let first = Self.load(spec.before, sessionId: resolvedSessionId)
            async let second = Self.load(spec.after, sessionId: resolvedSessionId)
            let (a, b) = await (first, second)
            before = a
            after = b
            failed = a == nil || b == nil
        }
    }

    private static func load(_ source: String, sessionId: String) async -> Data? {
        guard let raw = try? await OS1API.conversationImage(source: source, sessionId: sessionId)
        else { return nil }
        return await DisplayableImageData.prepare(raw)
    }

    private func placeholder(symbol: String?) -> some View {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(.fill.tertiary)
            .frame(height: 180)
            .overlay {
                if let symbol {
                    Image(systemName: symbol).foregroundStyle(.tertiary)
                } else {
                    ProgressView().controlSize(.small)
                }
            }
    }

    private func slider(before: Data, after: Data) -> some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let split = width * position
            ZStack(alignment: .leading) {
                DataImage(data: before)
                DataImage(data: after)
                    .mask(alignment: .trailing) {
                        Rectangle().frame(width: max(0, width - split))
                    }
                Rectangle()
                    .fill(.white)
                    .frame(width: 2)
                    .shadow(color: .black.opacity(0.35), radius: 2)
                    .offset(x: split - 1)
                handle
                    .position(x: split, y: geometry.size.height / 2)
                label("Before", alignment: .topLeading)
                label("After", alignment: .topTrailing)
            }
            .contentShape(Rectangle())
            #if os(iOS)
            .onTapGesture(coordinateSpace: .local) { location in
                set(location.x / max(width, 1), animated: true)
            }
            .gesture(HorizontalPan { x in set(x / max(width, 1), animated: false) })
            #else
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        set(value.location.x / max(width, 1), animated: false)
                    }
            )
            #endif
        }
        .modifier(CappedAspect(ratio: aspectRatio(of: before), maxHeight: Self.maxHeight))
        .overlay(alignment: .bottomTrailing) { expandButton(before: before, after: after) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Before and after")
        .accessibilityValue("\(Int((position * 100).rounded())) percent before")
        .accessibilityAdjustableAction { direction in
            set(position + (direction == .increment ? 0.1 : -0.1), animated: true)
        }
    }

    private var handle: some View {
        Image(systemName: "chevron.left.chevron.right")
            .font(.caption.weight(.bold))
            .foregroundStyle(.black.opacity(0.8))
            .frame(width: 30, height: 30)
            .background(.white, in: Circle())
            .shadow(color: .black.opacity(0.3), radius: 3, y: 1)
    }

    private func label(_ text: String, alignment: Alignment) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(.black.opacity(0.55), in: Capsule())
            .padding(8)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: alignment)
            .allowsHitTesting(false)
    }

    @ViewBuilder
    private func expandButton(before: Data, after: Data) -> some View {
        let gallery = [
            PreviewImage(id: "before", source: .data(before), walkthroughLabel: .before),
            PreviewImage(id: "after", source: .data(after), walkthroughLabel: .after),
        ]
        Button {
            expanded = true
        } label: {
            Image(systemName: "arrow.up.left.and.arrow.down.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(.black.opacity(0.55), in: Circle())
        }
        .buttonStyle(.plain)
        .padding(8)
        .accessibilityLabel("Expand")
        .help("Expand")
        #if os(iOS)
        .fullScreenCover(isPresented: $expanded) {
            FullScreenImagePreview(items: gallery, index: 0)
        }
        #else
        .sheet(isPresented: $expanded) {
            MacImagePreview(images: [before, after], index: 0)
        }
        #endif
    }

    private func set(_ value: CGFloat, animated: Bool) {
        let clamped = min(1, max(0, value))
        if animated, !reduceMotion {
            withAnimation(.snappy(duration: 0.2, extraBounce: 0)) { position = clamped }
        } else {
            position = clamped
        }
    }

    private func aspectRatio(of data: Data) -> CGFloat {
        #if os(iOS)
        let size = UIImage(data: data)?.size ?? CGSize(width: 16, height: 9)
        #else
        let size = NSImage(data: data)?.size ?? CGSize(width: 16, height: 9)
        #endif
        guard size.width > 0, size.height > 0 else { return 16 / 9 }
        return size.width / size.height
    }
}

/// Sizes its content to `ratio` across the offered width, unless that would
/// be taller than `maxHeight`: then the height is capped and the width
/// shrinks to keep the ratio. `.aspectRatio` plus `.frame(maxHeight:)` can't
/// do this inside a scroll view, which offers no height to clamp against.
private struct CappedAspect: ViewModifier {
    let ratio: CGFloat
    let maxHeight: CGFloat

    func body(content: Content) -> some View {
        CappedAspectLayout(ratio: ratio, maxHeight: maxHeight) { content }
    }

    private struct CappedAspectLayout: Layout {
        let ratio: CGFloat
        let maxHeight: CGFloat

        func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
            let width = proposal.width ?? maxHeight * ratio
            let height = width / ratio
            guard height > maxHeight else { return CGSize(width: width, height: height) }
            return CGSize(width: maxHeight * ratio, height: maxHeight)
        }

        func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
            for subview in subviews {
                subview.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
            }
        }
    }
}

#if os(iOS)
/// A pan that only begins when the finger first moves sideways. A SwiftUI
/// `DragGesture` claims every touch on the stills, so a vertical swipe that
/// starts on a tall pair can't scroll the transcript; this one fails on a
/// vertical start and leaves the swipe to the scroll view.
private struct HorizontalPan: UIGestureRecognizerRepresentable {
    let onChange: (CGFloat) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.delegate = context.coordinator
        return pan
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        guard recognizer.state == .began || recognizer.state == .changed else { return }
        onChange(context.converter.localLocation.x)
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard let pan = recognizer as? UIPanGestureRecognizer else { return true }
            let velocity = pan.velocity(in: pan.view)
            return abs(velocity.x) > abs(velocity.y)
        }
    }
}
#endif
