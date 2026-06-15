//
//  ConversationViewModel.swift
//  Alfred
//
//  The conversation's logic: holds the durable message list + the in-flight live turn,
//  drives send/cancel/approval/question, and consumes an AsyncStream<RunEvent> — the one
//  transport seam. Today the stream is REST+SSE (AlfredClient.events); a future VoiceSession
//  would emit the same RunEvents into the same view model, so nothing here assumes SSE.
//
//  RunEvent handling mirrors clients/web/src/Chat.tsx (without its most defensive web-only
//  edge cases): a token grows the trailing text segment (a new one opens after a tool chip);
//  tool_call_start appends a tool chip and tool_call_end flips it done; done/cancelled reload
//  history (the durable turns replace the live block) and clear busy; error appends a warning;
//  title sets the title + notifies the parent; interaction_required fetches the row and, if
//  still pending, presents the matching card (and fires a local notification when backgrounded);
//  interaction_resolved clears any open card.
//

import Foundation

/// One ordered piece of the in-flight run's output, in the order things actually happened:
/// a `text` segment grows as tokens stream; a `tool` chip accumulates (never removed) and
/// stops pulsing (`done = true`) when its `tool_call_end` arrives. Mirrors the web client's
/// LiveSegment so real interleaving (text → tool → more text) renders as one live block.
nonisolated enum LiveSegment: Identifiable, Hashable {
    case text(id: String, String)
    case tool(id: String, name: String, args: JSONValue?, done: Bool)

    var id: String {
        switch self {
        case .text(let id, _): return id
        case .tool(let id, _, _, _): return id
        }
    }
}

/// An approval the run is paused on. Identified by the interaction id so SwiftUI can present
/// it via `.sheet(item:)` / `if let`.
struct ActiveApproval: Identifiable {
    let interactionId: String
    let prompt: ApprovalPrompt
    var id: String { interactionId }
}

/// An agent-initiated question (ask_user) the run is paused on.
struct ActiveQuestion: Identifiable {
    let interactionId: String
    let prompt: QuestionPrompt
    var id: String { interactionId }
}

@MainActor
@Observable
final class ConversationViewModel {
    // MARK: - Public state (observed by the view)

    /// The durable transcript, reloaded from the server on each terminal event.
    var messages: [ChatMessage] = []
    /// The in-flight run's live output as one ordered block; cleared when history reloads
    /// (it then carries the turn durably) or on error.
    var liveSegments: [LiveSegment] = []
    /// A monotonic counter bumped on every live-segment mutation. The view observes this cheap
    /// scalar to drive auto-scroll instead of diffing the whole `liveSegments` array per token.
    var liveTick: Int = 0
    /// A run is in flight — drives the disabled composer + the Stop button.
    var busy: Bool = false
    /// The conversation title (header). Updated by the `title` event or a reloaded meta.
    var title: String?
    /// The currently-open approval / question card, if the run is paused on one.
    var approval: ActiveApproval?
    var question: ActiveQuestion?
    /// A transient error to surface as a banner (e.g. "Alfred is already working…").
    var errorBanner: String?
    /// The token/cost footer's baseline — the sum across the conversation's COMPLETED runs, read
    /// from the meta endpoint (excludes the in-flight run, whose rollup is 0 until it finishes).
    var baseTokens: Int = 0
    var baseCostUsd: Double = 0
    /// The live overlay — the current run's cumulative total from the latest `usage` event. Added
    /// on top of the baseline so the footer climbs during a run, then cleared (and the baseline
    /// re-fetched) on the terminal event so the two never double-count.
    var runTokens: Int = 0
    var runCostUsd: Double = 0
    /// Called when the title changes, so the parent (list/header) can update + reload the list.
    var onTitleChange: ((String) -> Void)?
    /// The voice layer, set while hands-free is active. `tts_audio` events are forwarded to it for
    /// playback and it's told when a run terminates so it can resume listening. Weak: the
    /// controller owns its own lifecycle (started/stopped by the view), voice is purely additive
    /// and only active when wired — text chat behaves identically when this is nil.
    weak var voice: VoiceController?

    // MARK: - Dependencies

    private let conversationId: String
    private let client: ConversationTransport
    private let notifications: NotificationManager

    /// The Task consuming the event stream. Cancelled in `stop()`.
    private var streamTask: Task<Void, Never>?
    /// Set once the stream delivers a terminal event (done/cancelled/error) — gates the
    /// initial meta load so its (possibly stale) `activeRun` snapshot can't re-set busy after
    /// the run already ended. Mirrors the web client's `terminalSeenRef`. Reset when a NEW run
    /// is observed (send / a live event after a terminal one) so a later run can restore busy.
    private var terminalSeen = false
    /// Set when a `cancelled` event lands: the worker may flush late token/tool_call_*/title/
    /// interaction_required NOTIFYs that would resurrect the live block or retitle the aborted
    /// run. Drop those while set; cleared once the post-cancel reload settles and at the start
    /// of a fresh local run. Mirrors the web client's `cancelledRef`.
    private var cancelledStraggler = false

    init(conversationId: String, client: ConversationTransport, notifications: NotificationManager) {
        self.conversationId = conversationId
        self.client = client
        self.notifications = notifications
    }

    // MARK: - Lifecycle

    /// Load history + meta (initial busy from `activeRun`), then open the event stream.
    /// Idempotent: a second call while a stream is live is a no-op for the stream.
    func start() {
        Task { [weak self] in
            await self?.loadHistory()
        }
        Task { [weak self] in
            await self?.loadMeta()
        }
        guard streamTask == nil else { return }
        streamTask = Task { [weak self] in
            guard let self else { return }
            for await event in self.client.events(conversationId: self.conversationId) {
                if Task.isCancelled { break }
                self.handle(event)
            }
        }
    }

    /// Cancel the event-stream Task. Safe to call when nothing is running.
    func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    // MARK: - Sending

    /// Optimistically append the user message, upload any attachments already resolved by the
    /// caller, and POST. A 409 (the conversation is already busy) surfaces as a banner without
    /// flipping local busy — the in-flight run owns that. Other failures append a warning line.
    func send(text: String, attachments: [Attachment]) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return }
        guard !busy else { return }

        errorBanner = nil
        // A fresh local run: its live events count again, and a later activeRun snapshot may
        // legitimately restore busy (clear the gates the previous run set). Reset the live usage
        // overlay too — defensive: every terminal path already clears it, so this only matters if
        // a future terminal path forgets to (then the new run's first `usage` event overwrites it).
        cancelledStraggler = false
        terminalSeen = false
        runTokens = 0
        runCostUsd = 0
        let messageText = trimmed.isEmpty ? nil : trimmed
        let optimistic = ChatMessage.optimisticUser(text: messageText, attachments: attachments)
        messages.append(optimistic)
        busy = true

        do {
            try await client.send(
                conversationId: conversationId,
                text: messageText,
                attachments: attachments
            )
        } catch AlfredError.busy {
            // 409: nothing was sent — drop the optimistic user message so it doesn't ghost
            // (linger, then vanish on the next reload).
            busy = false
            messages.removeAll { $0.id == optimistic.id }
            errorBanner = AlfredError.busy.localizedDescription
        } catch {
            busy = false
            appendWarning(error.localizedDescription)
        }
    }

    // MARK: - Cancellation

    /// Stop the active run via the route, which owns the terminal `cancelled` write + NOTIFY.
    /// On a 200 we never tear down optimistically — the `cancelled` event delivered over the
    /// stream does that (matching §10.6). On a 409 (nothing active — the run finished or failed
    /// just before the tap) we self-heal exactly like the web client: clear busy and reload, so
    /// a conversation can't stay stuck behind the one-active-run index with no terminal event.
    /// A network failure leaves state as-is so the Stop button stays available for a retry.
    func cancelRun() async {
        do {
            let cancelled = try await client.cancel(conversationId: conversationId)
            if !cancelled {
                busy = false
                await loadHistory()
            }
        } catch {
            // Network failure: leave state as-is — the Stop button stays available for a retry.
        }
    }

    // MARK: - Approval / question resolution

    /// Resolve the open approval. Clears the card immediately (first-writer-wins is enforced
    /// server-side; an `interaction_resolved` event would clear it anyway). `remember` only ever
    /// persists on an approve, matching the web client.
    func resolveApproval(approved: Bool, remember: Bool) async {
        guard let active = approval else { return }
        approval = nil
        let rememberChoice = approved && remember
        do {
            try await client.resolveApproval(
                active.interactionId,
                approved: approved,
                note: nil,
                remember: rememberChoice
            )
        } catch {
            // 409 (already resolved) is swallowed by the client; other failures are best-effort —
            // the run will time out (§10.4) if the resolution truly never landed.
        }
    }

    /// Resolve the open question with the selected option labels and/or free-form text.
    func resolveQuestion(selectedLabels: [String], freeformText: String?) async {
        guard let active = question else { return }
        question = nil
        let trimmed = freeformText?.trimmingCharacters(in: .whitespacesAndNewlines)
        let freeform = (trimmed?.isEmpty ?? true) ? nil : trimmed
        do {
            try await client.resolveQuestion(
                active.interactionId,
                selectedLabels: selectedLabels,
                freeformText: freeform
            )
        } catch {
            // Best-effort, as with approvals.
        }
    }

    // MARK: - Event handling

    private func handle(_ event: RunEvent) {
        // Straggler guard: after a `cancelled`, the worker keeps flushing whatever its NOTIFY
        // chain already queued — drop those live-output events so they can't resurrect the live
        // block or retitle the aborted run. interaction_required is included because a straggler
        // would re-open a card the cancel cascade already resolved (§10.9 invariant 4); title
        // because a post-cancel auto-title must not land out of band. The terminal events
        // (done/cancelled/error) and interaction_resolved still flow through.
        if cancelledStraggler {
            switch event {
            case .token, .toolCallStart, .toolCallEnd, .interactionRequired, .title, .ttsAudio, .usage:
                return
            default:
                break
            }
        }

        switch event {
        case .token(let text):
            observedLiveEvent()
            appendToken(text)

        case .toolCallStart(let id, let toolName, let args):
            observedLiveEvent()
            liveSegments.append(.tool(id: id, name: toolName, args: args, done: false))
            liveTick += 1

        case .toolCallEnd(let id):
            // Mark the matching chip done (it stays — just stops pulsing). Unknown id → no-op.
            // Mutate the single matching element in place rather than rebuilding the array.
            guard let i = liveSegments.firstIndex(where: { seg in
                if case .tool(let segId, _, _, _) = seg { return segId == id }
                return false
            }) else { break }
            if case .tool(let segId, let name, let args, _) = liveSegments[i] {
                liveSegments[i] = .tool(id: segId, name: name, args: args, done: true)
                liveTick += 1
            }

        case .done, .cancelled:
            // On either terminal event the durable turns replace the live block: reload history
            // and clear it in the same render. A cancel's cascade already resolved any pending
            // interaction (§10.9 invariant 4), so clear an open card too.
            terminalSeen = true
            busy = false
            approval = nil
            question = nil
            // Tell the voice layer the run finished (no-op when voice is off — it's nil). A cancel
            // (the Stop button) must STOP playback immediately; a natural `done` lets the queue
            // drain. Passing the distinction is what makes Stop actually interrupt (BUGS.md bug 1).
            let didCancel: Bool
            if case .cancelled = event { didCancel = true } else { didCancel = false }
            voice?.runCompleted(cancelled: didCancel)
            // On cancel, drop stragglers until the post-cancel reload settles (they flush within
            // the same tick as the cancel NOTIFY, so by then they're gone) — and a run started
            // afterwards from another ingress must stream normally, hence the time-bounded clear.
            if didCancel { cancelledStraggler = true }
            // Clear the live footer overlay and re-fetch the baseline: meta now includes this
            // run's rollup, so base+0 equals the value the overlay was showing — no double-count.
            runTokens = 0
            runCostUsd = 0
            Task { [weak self] in
                await self?.loadHistory()
                await self?.loadMeta()
                self?.cancelledStraggler = false
            }

        case .error(let message):
            terminalSeen = true
            liveSegments = []
            liveTick += 1
            busy = false
            // An error is terminal too — stop any in-flight playback (don't drain a half-spoken
            // reply) and resume listening (no-op when voice is off).
            voice?.runCompleted(cancelled: true)
            appendWarning(message)
            // Clear the live footer overlay and re-fetch the baseline (it captures whatever the
            // run billed before failing — rollupUsage runs on the failed path too).
            runTokens = 0
            runCostUsd = 0
            Task { [weak self] in
                await self?.loadMeta()
            }

        case .ttsAudio(let seq, let path, let mimeType):
            // A server-synthesized TTS clip is ready. Forward it to the voice layer for ordered
            // playback; it's invisible to the transcript (no message row). A live event for the
            // current run, so keep the run-tracking flags honest.
            observedLiveEvent()
            voice?.enqueueClip(seq: seq, path: path, mimeType: mimeType)

        case .usage(let p, let cc, let cost):
            // A cumulative snapshot for the current run (a full total, not a delta) — overlay it on
            // the baseline so the footer climbs live. Last-wins, so a missed event self-corrects.
            observedLiveEvent()
            runTokens = p + cc
            runCostUsd = cost

        case .title(let newTitle):
            title = newTitle
            onTitleChange?(newTitle)

        case .interactionRequired(let interactionId, let kind):
            observedLiveEvent()
            presentInteraction(interactionId: interactionId, kind: kind)

        case .interactionResolved:
            // Resolved by some ingress (this app, the web client, a timeout, or the cancel
            // cascade) — tear down whichever card is open.
            approval = nil
            question = nil

        case .unknown:
            break
        }
    }

    /// A live event (token / tool start / interaction) for the current run arrived. If it lands
    /// after a terminal event, a NEW run is underway — reset `terminalSeen` so a later activeRun
    /// snapshot can restore busy. (Not reset in start()/loadMeta — that would reintroduce the
    /// stale-snapshot race the flag guards within a single run.)
    private func observedLiveEvent() {
        if terminalSeen { terminalSeen = false }
        if !busy { busy = true }
    }

    /// Extend the trailing text segment, or open a new one if the last segment is a tool — so
    /// text arriving after a tool starts a fresh segment below that chip (real order).
    private func appendToken(_ text: String) {
        if case .text(let id, let existing)? = liveSegments.last {
            liveSegments[liveSegments.count - 1] = .text(id: id, existing + text)
        } else {
            liveSegments.append(.text(id: UUID().uuidString, text))
        }
        liveTick += 1
    }

    /// Fetch the interaction row and, if still `pending`, present the matching card and fire a
    /// (best-effort, backgrounded-only) local notification. A late event for an already-resolved
    /// interaction renders nothing.
    private func presentInteraction(interactionId: String, kind: InteractionKind) {
        Task { [weak self] in
            guard let self else { return }
            let interaction: Interaction
            do {
                interaction = try await self.client.interaction(interactionId)
            } catch {
                // A failed fetch / decode (e.g. a renamed prompt field) would otherwise park the
                // run with no card and no trace — surface it instead of silently dropping.
                print("presentInteraction(\(interactionId)) failed: \(error)")
                return
            }
            guard interaction.status == "pending" else { return }

            switch interaction.prompt {
            case .approval(let prompt):
                self.question = nil
                self.approval = ActiveApproval(interactionId: interactionId, prompt: prompt)
            case .question(let prompt):
                self.approval = nil
                self.question = ActiveQuestion(interactionId: interactionId, prompt: prompt)
            }
            self.notifications.notifyInteraction(
                kind: interaction.kind, conversationId: self.conversationId
            )
        }
    }

    // MARK: - History / meta loads

    /// Reload the durable transcript and drop the transient live block in one update: the
    /// reloaded turns carry the streamed text + tool chips durably, so there's no gap and no
    /// overlap. A failed reload still clears the live block so it can't linger with no durable turn.
    private func loadHistory() async {
        do {
            let wire = try await client.messages(conversationId)
            messages = wire.map(ChatMessage.init(from:))
            liveSegments = []
        } catch {
            liveSegments = []
        }
        liveTick += 1
    }

    /// Read the conversation meta for the title and a refresh-proof busy state: if a run is
    /// already in flight (the screen was opened mid-run), restore busy so the Stop button shows —
    /// the owner's only way to free a conversation stuck behind the one-active-run index.
    private func loadMeta() async {
        guard let meta = try? await client.conversation(conversationId) else { return }
        if let t = meta.title { title = t }
        // The footer baseline — completed runs only (coalesced from the optional wire fields).
        baseTokens = meta.tokens ?? 0
        baseCostUsd = Double(meta.costUsd ?? "0") ?? 0
        // `activeRun == false` is authoritative: clear any stale busy (e.g. a run that finished
        // while the app was backgrounded, so the stream was stopped and the terminal event never
        // arrived). Only the set-true direction is gated by `terminalSeen` so a stale snapshot
        // can't re-stick Stop after the stream already delivered a terminal event.
        if !meta.activeRun {
            busy = false
        } else if !terminalSeen {
            busy = true
        }
    }

    // MARK: - Helpers

    private func appendWarning(_ message: String) {
        let part = ContentPart(
            type: "text", text: "\u{26A0}\u{FE0F} \(message)",
            name: nil, id: nil, args: nil, path: nil, mimeType: nil
        )
        messages.append(ChatMessage(id: UUID().uuidString, role: "assistant", content: [part]))
    }
}
