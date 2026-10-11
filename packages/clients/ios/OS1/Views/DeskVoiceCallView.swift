import SwiftUI

/// The Desk voice call, full screen — the shape ChatGPT's voice mode set the
/// expectation for: one orb that reacts to whoever is currently talking, the
/// spoken line as captions under it, and a small row of controls.
///
/// The view owns no call state. `DeskVoiceEngine` is the whole machine; this
/// reads `state`/`audioLevel`/`caption` off it and sends back three intents
/// (mute, minimize, hang up). Minimizing deliberately leaves the call running:
/// the Desk header keeps its lit mic button, and tapping it comes back here.
struct DeskVoiceCallView: View {
    let engine: DeskVoiceEngine

    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var showCaptions = true
    @State private var rotation: Double = 0

    var body: some View {
        ZStack {
            OS1VisualStyle.background
                .ignoresSafeArea()

            VStack(spacing: 0) {
                topBar
                Spacer(minLength: 12)
                orb
                status
                Spacer(minLength: 12)
                captions
                Spacer(minLength: 16)
                controls
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 28)
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 560)
        #endif
        // The call says when it went live. Connecting takes long enough that
        // people look at the screen to find out whether it worked — and this
        // is the one screen you're most likely to be holding to your ear, not
        // watching. A refusal knocks instead.
        .haptic(trigger: engine.state) { previous, state in
            switch state {
            case .listening where previous == .connecting: .armed
            case .error where previous != .error: .warn
            default: nil
            }
        }
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.linear(duration: 9).repeatForever(autoreverses: false)) {
                rotation = 360
            }
        }
    }

    // MARK: - Top bar

    private var topBar: some View {
        HStack {
            Button {
                dismiss()
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .frame(width: 40, height: 40)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Minimize the call")

            Spacer()

            HStack(spacing: 6) {
                Image(systemName: engine.session == nil ? "lamp.desk" : "bubble.left.and.text.bubble.right")
                Text(engine.callTitle)
                    .lineLimit(1)
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(OS1VisualStyle.textDim)

            Spacer()

            // Balances the leading chevron so the title stays centered.
            Color.clear.frame(width: 40, height: 40)
        }
    }

    // MARK: - Orb

    /// 0…1, but never fully at rest: a floor keeps the orb alive while the
    /// model is thinking or working, when there is no audio at all to meter.
    private var level: CGFloat {
        let metered = CGFloat(engine.audioLevel)
        switch engine.state {
        case .thinking, .action, .connecting: return max(metered, 0.28)
        default: return metered
        }
    }

    private var orbColors: [Color] {
        switch engine.state {
        case .error:
            [OS1VisualStyle.red, OS1VisualStyle.red.opacity(0.5), OS1VisualStyle.red]
        case .action:
            [OS1VisualStyle.purple, OS1VisualStyle.blue, OS1VisualStyle.purple]
        default:
            [OS1VisualStyle.blue, OS1VisualStyle.purple, OS1VisualStyle.blue]
        }
    }

    private var orbGradient: AngularGradient {
        AngularGradient(gradient: Gradient(colors: orbColors), center: .center)
    }

    private var orb: some View {
        ZStack {
            // Halo — the part that reads as loudness from across the room.
            Circle()
                .fill(orbGradient)
                .rotationEffect(.degrees(rotation))
                .blur(radius: 44)
                .opacity(0.35 + 0.4 * level)
                .scaleEffect(1.0 + 0.34 * level)

            // Core.
            Circle()
                .fill(orbGradient)
                .rotationEffect(.degrees(-rotation * 0.6))
                .overlay {
                    // Pulls the middle brighter so the disc reads as a sphere
                    // rather than a flat ring of colour.
                    Circle().fill(
                        RadialGradient(
                            colors: [.white.opacity(0.45), .clear],
                            center: .init(x: 0.36, y: 0.32),
                            startRadius: 0,
                            endRadius: 110
                        )
                    )
                }
                .clipShape(.circle)
                .scaleEffect(0.78 + 0.17 * level)
                .opacity(engine.muted && engine.state != .speaking ? 0.5 : 1)
        }
        .frame(width: 220, height: 220)
        .animation(
            reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.72),
            value: level
        )
        .animation(.easeInOut(duration: 0.3), value: engine.state)
        .accessibilityHidden(true)
    }

    private var status: some View {
        VStack(spacing: 6) {
            Text(engine.state == .error ? (engine.errorMessage ?? engine.state.label) : statusText)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(
                    engine.state == .error ? OS1VisualStyle.redInk : OS1VisualStyle.textDim
                )
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .animation(.easeInOut(duration: 0.2), value: statusText)
                .accessibilityAddTraits(.updatesFrequently)

            // "Listening" that never hears anything is the one failure the
            // status line can't express — the call really is up. This is where
            // that says so instead of leaving the screen looking healthy.
            if let hint = engine.hint, engine.state != .error {
                Text(hint)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.yellowInk)
                    .multilineTextAlignment(.center)
                    .transition(.opacity)
            }
        }
        .padding(.top, 28)
        .animation(.easeInOut(duration: 0.2), value: engine.hint)
    }

    private var statusText: String {
        engine.muted && engine.state == .listening ? "Muted" : engine.state.label
    }

    // MARK: - Captions

    @ViewBuilder
    private var captions: some View {
        if showCaptions, let caption = engine.caption, !caption.text.isEmpty {
            ScrollView {
                Text(caption.text)
                    .font(.title3.weight(caption.role == .user ? .regular : .medium))
                    .foregroundStyle(
                        caption.role == .user ? OS1VisualStyle.textDim : OS1VisualStyle.text
                    )
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.hidden)
            .defaultScrollAnchor(.bottom)
            .frame(maxHeight: 150)
            .accessibilityLabel(
                "\(caption.role == .user ? "You said" : "\(engine.counterpartName) said"): \(caption.text)"
            )
        } else {
            // Holds the orb still while captions come and go.
            Color.clear.frame(height: 1)
        }
    }

    // MARK: - Controls

    private var controls: some View {
        HStack(spacing: 28) {
            CallControlButton(
                systemImage: engine.muted ? "mic.slash.fill" : "mic.fill",
                label: engine.muted ? "Unmute the microphone" : "Mute the microphone",
                prominent: engine.muted
            ) {
                // Muting is a state you can't see with the phone at your ear.
                Haptics.play(.selection)
                engine.toggleMute()
            }
            .disabled(!engine.active)

            CallControlButton(
                systemImage: showCaptions ? "captions.bubble.fill" : "captions.bubble",
                label: showCaptions ? "Hide captions" : "Show captions",
                prominent: showCaptions
            ) {
                withAnimation(.easeInOut(duration: 0.2)) { showCaptions.toggle() }
            }

            CallControlButton(
                systemImage: engine.state == .error ? "xmark" : "phone.down.fill",
                label: engine.state == .error ? "Close" : "End the call",
                tint: OS1VisualStyle.red,
                onAccent: .white
            ) {
                // Closes the pair the connect cue opened.
                Haptics.play(.released)
                engine.stop()
                dismiss()
            }
        }
    }
}

/// One round control on the call screen. `prominent` is the "on" look for the
/// toggles; the hang-up button passes an explicit tint instead.
private struct CallControlButton: View {
    let systemImage: String
    let label: String
    var prominent = false
    var tint: Color?
    var onAccent: Color?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(foreground)
                .frame(width: 62, height: 62)
                .background(background, in: .circle)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var background: Color {
        if let tint { return tint }
        return prominent ? OS1VisualStyle.accent : OS1VisualStyle.raised
    }

    private var foreground: Color {
        if let onAccent { return onAccent }
        return prominent ? OS1VisualStyle.onAccent : OS1VisualStyle.text
    }
}
