//
//  ConversationView.swift
//  Alfred
//
//  The chat screen. Lazily builds a ConversationViewModel per conversation id, renders the
//  durable transcript plus a single live Alfred block (streamed text + tool chips + a
//  thinking indicator while busy), and a composer with a text field, an image attach
//  button, and a Send button that becomes Stop while a run is in flight. Approval and
//  question cards render inline above the composer, wired to the view model's resolve methods.
//
//  Pending attachments are uploaded by the view (through AppModel.client.upload) and held
//  locally as [Attachment]; the uploaded list is passed into vm.send and cleared on send.
//

import SwiftUI

struct ConversationView: View {
    let conversationId: String

    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase

    /// Built lazily in `.task(id: conversationId)` once the environment is available.
    @State private var vm: ConversationViewModel?

    // Composer state (view-owned; the view uploads, then hands Attachments to vm.send).
    @State private var draft = ""
    @State private var pending: [Attachment] = []
    @State private var uploading = false
    @State private var showPicker = false
    /// True once the stream was stopped because the app backgrounded — gates the
    /// foreground re-open so we don't double-start the freshly-built view model.
    @State private var stoppedForBackground = false

    /// The hands-free voice layer, created when the mic toggle is turned on and torn down when
    /// turned off / the conversation changes. Wired into the view model (`vm.voice`) so `tts_audio`
    /// events route to it. Voice is purely additive: when nil, text chat behaves identically.
    @State private var voice: VoiceController?

    var body: some View {
        VStack(spacing: 0) {
            if let vm {
                transcript(vm)
                cards(vm)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
                composer(vm)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(vm?.title ?? "Alfred")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: conversationId) {
            // Rebuild the view model whenever the conversation changes, and start it (load
            // history + meta + open the SSE stream). The previous vm, if any, is stopped, and
            // voice (tied to the old conversation) is torn down.
            vm?.stop()
            voice?.stop()
            voice = nil
            let model = ConversationViewModel(
                conversationId: conversationId,
                client: app.client,
                notifications: app.notifications
            )
            vm = model
            model.start()
        }
        .onDisappear {
            vm?.stop()
            voice?.stop()
            voice = nil
        }
        .onChange(of: scenePhase) { _, phase in
            // The SSE stream is suspended while backgrounded; stop it on background and
            // re-open it on return so a run that progressed while away is picked up again.
            // The flag gates the re-open so we don't double-start the view model that
            // `.task` already started on first appearance. Voice is stopped on background too —
            // its audio session/engine shouldn't hold the mic while suspended.
            guard let vm else { return }
            switch phase {
            case .background:
                vm.stop()
                voice?.stop()
                voice = nil
                stoppedForBackground = true
            case .active where stoppedForBackground:
                stoppedForBackground = false
                vm.start()
            default:
                break
            }
        }
    }

    // MARK: - Transcript

    private func transcript(_ vm: ConversationViewModel) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(Array(vm.messages.enumerated()), id: \.element.id) { index, message in
                        MessageView(
                            message: message,
                            mediaURL: mediaURL,
                            showName: showName(at: index, in: vm.messages)
                        )
                    }
                    if vm.busy || !vm.liveSegments.isEmpty {
                        liveBlock(vm)
                    }
                    if let banner = vm.errorBanner {
                        Text(banner)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    // Anchor for auto-scroll.
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomAnchor)
                }
                .padding(16)
            }
            // Animate on durable/state changes; while streaming, track the cheap liveTick counter
            // and scroll WITHOUT animation (coalesced) so fast token updates don't stutter — and
            // so we never diff the whole liveSegments array per token.
            .onChange(of: vm.messages) { scrollToBottom(proxy, animated: true) }
            .onChange(of: vm.liveTick) { scrollToBottom(proxy, animated: false) }
            .onChange(of: vm.busy) { scrollToBottom(proxy, animated: true) }
            .onAppear { scrollToBottom(proxy, animated: false) }
        }
    }

    /// The single cohesive live Alfred block: header, ordered segments (streamed text and
    /// accumulating tool chips), then a thinking indicator while still busy.
    private func liveBlock(_ vm: ConversationViewModel) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("ALFRED")
                .font(.caption2.weight(.semibold))
                .tracking(1.5)
                .foregroundStyle(.tertiary)
            ForEach(vm.liveSegments) { seg in
                switch seg {
                case .text(_, let text):
                    if !text.isEmpty {
                        // Plain Text while streaming — re-parsing markdown on every token would
                        // be O(n²) per turn. The turn renders as markdown once it finalizes into
                        // a durable bubble (MessageView, on history reload).
                        Text(text)
                            .textSelection(.enabled)
                    }
                case .tool(_, let name, let args, let done):
                    ToolChip(name: name, args: args, live: !done)
                }
            }
            if vm.busy {
                ProgressView()
                    .controlSize(.small)
                    .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Approval / question cards

    // Rendered inline above the composer (as the web client does), not as a sheet — so an
    // `interaction_resolved` from another ingress simply clears vm.approval / vm.question and
    // the card disappears, with no presentation-state to desync. The view never clears the
    // vm's interaction state itself; resolving goes through the vm, which owns the teardown.
    @ViewBuilder
    private func cards(_ vm: ConversationViewModel) -> some View {
        if let active = vm.approval {
            ApprovalCard(prompt: active.prompt) { approved, remember in
                Task { await vm.resolveApproval(approved: approved, remember: remember) }
            }
            // Identity per interaction so a new prompt resets the card's local @State.
            .id(active.interactionId)
        } else if let active = vm.question {
            QuestionCard(prompt: active.prompt) { labels, freeform in
                Task { await vm.resolveQuestion(selectedLabels: labels, freeformText: freeform) }
            }
            .id(active.interactionId)
        }
    }

    // MARK: - Composer

    private func composer(_ vm: ConversationViewModel) -> some View {
        VStack(spacing: 8) {
            if let voice, voice.isOn {
                voiceIndicator(voice)
            }
            if !pending.isEmpty || uploading {
                pendingStrip
            }
            HStack(spacing: 8) {
                Button { showPicker = true } label: {
                    Image(systemName: "paperclip")
                        .font(.title3)
                }
                .disabled(vm.busy || uploading)

                micButton(vm)

                TextField("Message Alfred…", text: $draft, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...5)
                    .disabled(vm.busy)

                if vm.busy {
                    Button {
                        Task { await vm.cancelRun() }
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.title3)
                    }
                    .tint(.red)
                } else {
                    Button {
                        sendDraft(vm)
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                    }
                    .disabled(!canSend)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
        .sheet(isPresented: $showPicker) {
            ImagePicker { jpeg in
                showPicker = false
                Task { await upload(jpeg) }
            }
            .padding()
            .presentationDetents([.height(160)])
        }
    }

    // MARK: - Voice

    /// The hands-free toggle. Tapping it creates + starts a VoiceController (wiring it into the
    /// view model so `tts_audio` events route to playback) or stops + tears it down.
    private func micButton(_ vm: ConversationViewModel) -> some View {
        Button {
            Task { await toggleVoice(vm) }
        } label: {
            Image(systemName: (voice?.isOn ?? false) ? "mic.fill" : "mic")
                .font(.title3)
        }
        .tint((voice?.isOn ?? false) ? Color.accentColor : Color.gray)
        .accessibilityLabel((voice?.isOn ?? false) ? "Turn voice off" : "Turn voice on")
    }

    private func toggleVoice(_ vm: ConversationViewModel) async {
        if let voice, voice.isOn {
            voice.stop()
            vm.voice = nil
            self.voice = nil
            return
        }
        let controller = VoiceController(
            conversationId: conversationId,
            transport: app.client,
            onTranscript: { [weak vm] transcript in
                // Optimistically reflect what Alfred heard as a user message; the durable row
                // arrives on the next history reload like any text turn.
                vm?.messages.append(ChatMessage.optimisticUser(text: transcript, attachments: []))
            }
        )
        voice = controller
        vm.voice = controller
        await controller.start()
        // start() may have failed (mic denied / session error) and stayed off — leave it wired so
        // the indicator/error surfaces; the next tap retries cleanly.
    }

    /// A clear listening/speaking indicator shown above the composer while voice is on.
    @ViewBuilder
    private func voiceIndicator(_ voice: VoiceController) -> some View {
        HStack(spacing: 8) {
            switch voice.phase {
            case .listening:
                Image(systemName: "waveform")
                    .foregroundStyle(.green)
                Text("Listening…")
            case .capturing:
                Image(systemName: "waveform")
                    .symbolEffect(.variableColor.iterative, options: .repeating)
                    .foregroundStyle(.green)
                Text("Listening…")
            case .thinking:
                ProgressView()
                    .controlSize(.small)
                Text("Thinking…")
            case .speaking:
                Image(systemName: "speaker.wave.2.fill")
                    .symbolEffect(.variableColor.iterative, options: .repeating)
                    .foregroundStyle(Color.accentColor)
                Text("Speaking…")
            case .off:
                EmptyView()
            }
            if voice.phase == .listening || voice.phase == .capturing {
                micLevelBar(voice.inputLevel)
            }
            if let message = voice.errorMessage {
                Text(message)
                    .foregroundStyle(.red)
            }
            Spacer()
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Live mic level (RMS) shown while listening, as an on-device calibration aid: the green fill
    /// crosses roughly a quarter at the speech threshold. If it never moves while you speak, the
    /// mic isn't delivering frames (an audio-route/engine problem, not a threshold one).
    @ViewBuilder
    private func micLevelBar(_ level: Float) -> some View {
        let fraction = CGFloat(min(1, max(0, level / 0.05)))
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.25))
                Capsule().fill(Color.green).frame(width: geo.size.width * fraction)
            }
        }
        .frame(width: 56, height: 4)
    }

    private var pendingStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(pending, id: \.path) { att in
                    ZStack(alignment: .topTrailing) {
                        if let url = mediaURL(att.path) {
                            AsyncImage(url: url) { image in
                                image.resizable().scaledToFill()
                            } placeholder: {
                                ProgressView()
                            }
                            .frame(width: 56, height: 56)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                        Button {
                            pending.removeAll { $0.path == att.path }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.white, .black.opacity(0.5))
                        }
                        .offset(x: 4, y: -4)
                    }
                }
                if uploading {
                    ProgressView()
                        .frame(width: 56, height: 56)
                }
            }
            .padding(.horizontal, 4)
        }
        .frame(height: 64)
    }

    // MARK: - Actions

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pending.isEmpty
    }

    private func sendDraft(_ vm: ConversationViewModel) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = pending
        guard !text.isEmpty || !attachments.isEmpty else { return }
        draft = ""
        pending = []
        Task { await vm.send(text: text, attachments: attachments) }
    }

    private func upload(_ jpeg: Data) async {
        uploading = true
        defer { uploading = false }
        do {
            let attachment = try await app.client.upload(
                conversationId: conversationId,
                jpegData: jpeg
            )
            pending.append(attachment)
        } catch {
            // Surface the failure quietly; the user can retry.
            vm?.errorBanner = "Image upload failed."
        }
    }

    private func mediaURL(_ path: String) -> URL? {
        app.client.mediaURL(conversationId: conversationId, path: path)
    }

    // The "ALFRED" label appears only on the first assistant bubble in a contiguous run of
    // Alfred output, so a sequence of tool + text turns isn't labeled over and over. Walk back
    // past tool-result messages and empty assistant turns (which render nothing); show the label
    // only when the previous rendered bubble was not the assistant. Mirrors the web client.
    private func rendersNothing(_ m: ChatMessage) -> Bool {
        m.role == "assistant" && m.text.isEmpty && m.toolUses.isEmpty && m.images.isEmpty
    }

    private func showName(at index: Int, in messages: [ChatMessage]) -> Bool {
        var j = index - 1
        while j >= 0 {
            let prev = messages[j]
            if prev.role == "tool" || rendersNothing(prev) {
                j -= 1
                continue
            }
            return prev.role != "assistant"
        }
        return true
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        if animated {
            withAnimation(.easeOut(duration: 0.15)) {
                proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
            }
        } else {
            proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
        }
    }

    private static let bottomAnchor = "alfred.transcript.bottom"
}
