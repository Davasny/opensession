import SwiftUI

#if os(iOS)
import UIKit

/// Finds the UIScrollView behind the transcript's SwiftUI `ScrollView`, so a
/// history page can move the reader by a relative amount. `ScrollPosition`
/// only takes absolute offsets, and the offset SwiftUI last reported can be a
/// frame old while a page lays out; adding to the live `contentOffset` is
/// exact, and a flick in progress keeps its momentum.
///
/// Install it as a `.background` of the scroll content.
struct TranscriptScrollNudge: UIViewRepresentable {
    let handle: Handle

    @MainActor
    final class Handle {
        fileprivate weak var scrollView: UIScrollView?

        /// Moves the visible content by `dy` points. False when no scroll
        /// view has been found yet.
        func nudge(by dy: CGFloat) -> Bool {
            guard let scrollView else { return false }
            var offset = scrollView.contentOffset
            offset.y += dy
            scrollView.contentOffset = offset
            return true
        }
    }

    func makeUIView(context: Context) -> Marker {
        let view = Marker()
        view.handle = handle
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: Marker, context: Context) {
        view.handle = handle
        view.attach()
    }

    final class Marker: UIView {
        var handle: Handle?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            attach()
        }

        func attach() {
            guard let handle, handle.scrollView == nil || handle.scrollView?.window == nil else { return }
            var view = superview
            while let current = view {
                if let scrollView = current as? UIScrollView {
                    handle.scrollView = scrollView
                    return
                }
                view = current.superview
            }
        }
    }
}
#else
/// The Mac keeps SwiftUI's absolute restore (see the iOS version).
struct TranscriptScrollNudge: View {
    @MainActor
    final class Handle {
        func nudge(by dy: CGFloat) -> Bool { false }
    }

    let handle: Handle
    var body: some View { Color.clear }
}
#endif
