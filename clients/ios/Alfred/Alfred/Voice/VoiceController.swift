//
//  VoiceController.swift
//  Alfred
//
//  Hands-free voice as an audio layer ON TOP of the existing ConversationTransport — not a
//  replacement WS transport (spec docs/specs/2026-06-14-voice-stt-tts.md, Approach B). One
//  toggle makes the app listen continuously, detect end-of-utterance on-device, upload the
//  WAV to the STT+run-creation route (transport.uploadAudio), and speak Alfred's reply as the
//  worker streams `tts_audio` clips back over the existing SSE channel.
//
//  Capture / endpointing / AEC are on-device; recognition + synthesis stay server-side
//  (INGRESSES §9.3). Apple voice-processing (setVoiceProcessingEnabled) runs on the engine input
//  node; its echo canceller removes Alfred's playback — rendered through this SAME engine — from
//  the mic. That's what lets the user talk OVER Alfred (barge-in) without the VAD tripping on his
//  speech, and it's required for the built-in-speaker case (loud loudspeaker → mic echo). It
//  works the same over Bluetooth, where the mic + speaker share the HFP link.
//
//  Route changes — notably a Bluetooth HFP link engaging when recording starts — make the engine
//  post AVAudioEngineConfigurationChange, which STOPS the engine and invalidates the input tap.
//  We observe it and rebuild (reconnect the player, reinstall the tap, restart); without that the
//  mic silently stops delivering frames and the loop hangs at "listening".
//
//  State machine: off → listening → capturing → thinking → speaking → listening.
//   • listening  — engine running, VAD watching for speech onset; mic level surfaced to the UI.
//   • capturing  — buffering PCM from speech onset until ~1.2s of trailing silence.
//   • thinking   — the utterance was uploaded; waiting for the run + its first tts clip.
//   • speaking   — playing the tts_audio queue; mic stays open (AEC) so the user can barge in.
//  Barge-in (spec: STOP PLAYBACK ONLY, never cancel the run): user speech while `speaking` stops
//  local playback and starts capturing; the interrupted run finishes server-side, and because
//  runs serialize per conversation (§7.6) the new utterance posts once it terminates.
//

@preconcurrency import AVFoundation
import Foundation

@MainActor
@Observable
final class VoiceController {
    /// The user-visible phase of the voice loop. `off` means the engine is stopped.
    enum Phase: Equatable {
        case off
        case listening
        case capturing
        case thinking
        case speaking
    }

    // MARK: - Observed state (drives the UI indicator)

    private(set) var phase: Phase = .off
    /// A transient error to surface (mic permission denied, audio session failure, …).
    private(set) var errorMessage: String?
    /// Most recent mic RMS (0…~1) while listening/capturing, surfaced as a live level in the UI so
    /// the energy VAD threshold can be eyeballed and calibrated on-device. 0 when not listening.
    private(set) var inputLevel: Float = 0

    var isOn: Bool { phase != .off }

    // MARK: - Dependencies

    private let conversationId: String
    private let transport: ConversationTransport
    /// Optimistically reflect the recognized transcript as a user message in the transcript view.
    private let onTranscript: (String) -> Void

    // MARK: - Audio

    private let engine = AVAudioEngine()
    private let wireSampleRate: Double = 16_000
    /// Observer for AVAudioEngineConfigurationChange (route changes / Bluetooth HFP). On fire we
    /// rebuild the graph + tap — see rebuildAndStart.
    private var configObserver: NSObjectProtocol?

    /// TTS clips play through an AVAudioPlayerNode attached to the SAME engine as the mic. This is
    /// required with voice-processing on: the VPIO I/O unit owns the output device, so a detached
    /// AVPlayer would be silenced — and routing playback through the engine also gives the echo
    /// canceller the played audio as its reference, so the mic doesn't hear Alfred during barge-in.
    private let playerNode = AVAudioPlayerNode()
    /// Fixed connection format for the player node; clips are decoded/converted to it. 24 kHz mono
    /// matches the Google (Gemini-native) TTS output, so the common path needs no resample; the
    /// engine's mixer converts to the hardware output rate.
    private let playbackFormat = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
    /// Clips downloaded-or-playing but not yet finished; the run drains to listening when it hits 0.
    private var clipsPending = 0
    /// Bumped on every stopPlayback (barge-in / full stop) to invalidate in-flight downloads and
    /// the completion handlers of buffers scheduled for an interrupted run.
    private var playbackEpoch = 0
    /// Serializes clip download+schedule so playback order matches arrival (seq) order even though
    /// each clip is fetched asynchronously.
    private var clipChain: Task<Void, Never> = Task {}

    // MARK: - VAD / capture buffers

    /// Captured 16 kHz mono Int16 samples for the current utterance.
    private var captured: [Int16] = []
    /// Rolling count of consecutive low-energy (silent) tap callbacks once speech has started.
    private var trailingSilence: TimeInterval = 0
    /// Whether the VAD has seen speech onset for the current capture window.
    private var speechStarted = false
    /// Total captured duration (seconds), to bound a runaway capture.
    private var capturedDuration: TimeInterval = 0

    // Endpointing constants (energy-based; tuned for AEC'd voice-chat input).
    private let energyThreshold: Float = 0.012          // RMS over which a frame counts as speech.
    private let trailingSilenceToEnd: TimeInterval = 1.2 // silence after speech → utterance end.
    private let minUtterance: TimeInterval = 0.3         // ignore blips shorter than this.
    private let maxUtterance: TimeInterval = 30.0        // hard cap on a single capture.

    // MARK: - Run coordination

    /// True while a run we kicked off (or barged into) is still in flight server-side. We must
    /// not upload the next utterance until it reaches a terminal event (runs serialize, §7.6).
    private var runActive = false
    /// A captured utterance awaiting the active run's terminal event before it can be uploaded
    /// (the barge-in case). Holds the encoded WAV.
    private var pendingUtterance: Data?
    /// Whether any TTS clip has been enqueued for the current run (distinguishes thinking vs.
    /// speaking when `done` arrives — a silent run with no clips returns straight to listening).
    private var anyClipEnqueued = false
    /// Set when the run's terminal event arrived while clips were still draining; we go back to
    /// listening once the player empties.
    private var runDoneWaitingForDrain = false

    init(
        conversationId: String,
        transport: ConversationTransport,
        onTranscript: @escaping (String) -> Void
    ) {
        self.conversationId = conversationId
        self.transport = transport
        self.onTranscript = onTranscript
    }

    // MARK: - Toggle

    /// Start the audio engine and begin listening. Requests mic permission first; on denial sets
    /// `errorMessage` and stays `off`.
    func start() async {
        guard phase == .off else { return }
        errorMessage = nil

        let granted = await requestMicPermission()
        guard granted else {
            errorMessage = "Microphone access is needed for voice. Enable it in Settings."
            return
        }

        do {
            try configureSession()
            try startEngine()
            observeConfigurationChanges()
        } catch {
            teardownAudio()
            errorMessage = "Couldn't start voice: \(error.localizedDescription)"
            return
        }
        resetCapture()
        phase = .listening
    }

    /// Stop everything: engine, playback, capture state. Returns to `off`.
    func stop() {
        stopPlayback()
        teardownAudio()
        captured = []
        pendingUtterance = nil
        runActive = false
        anyClipEnqueued = false
        runDoneWaitingForDrain = false
        phase = .off
    }

    /// Toggle convenience for the UI button.
    func toggle() async {
        if isOn { stop() } else { await start() }
    }

    // MARK: - Run-event hooks (called by ConversationViewModel)

    /// A `tts_audio` clip is ready. Fetch its `/media` URL and enqueue it for ordered playback.
    /// Best-effort — a missing URL just drops the clip. `seq` is informational; the worker emits
    /// clips in order over a serialized chain and SSE preserves that order, so enqueue order is
    /// playback order.
    func enqueueClip(seq: Int, path: String, mimeType: String) {
        guard isOn else { return }
        // While capturing (the user has barged in), a clip belongs to the run they just
        // interrupted — barge-in means "stop playback", so drop it locally rather than start
        // speaking over the fresh capture. The interrupted run still completes server-side.
        guard phase != .capturing else { return }
        guard let url = transport.mediaURL(conversationId: conversationId, path: path) else { return }
        runActive = true
        anyClipEnqueued = true
        runDoneWaitingForDrain = false
        // Playback means we're (still) speaking; the mic stays open during `speaking` so the user
        // can barge in (AEC removes Alfred's own voice from the input).
        if phase == .thinking || phase == .listening {
            phase = .speaking
        }
        clipsPending += 1
        let epoch = playbackEpoch
        // Chain after the previous clip so async downloads schedule in arrival (seq) order.
        let prev = clipChain
        clipChain = Task { [weak self] in
            await prev.value
            await self?.downloadAndSchedule(url: url, epoch: epoch)
        }
    }

    /// Fetch one clip, decode it to the player node's format, and schedule it. Ordering is
    /// guaranteed by the clipChain. A fetch/decode failure — or a stale epoch after barge-in —
    /// just drops the clip and settles its pending count.
    private func downloadAndSchedule(url: URL, epoch: Int) async {
        guard epoch == playbackEpoch, isOn else { clipFinished(epoch: epoch); return }
        let data: Data
        do {
            (data, _) = try await URLSession.shared.data(from: url)
        } catch {
            clipFinished(epoch: epoch)
            return
        }
        guard epoch == playbackEpoch, isOn,
              let buffer = Self.decodeToBuffer(data, format: playbackFormat)
        else {
            clipFinished(epoch: epoch)
            return
        }
        if !engine.isRunning { try? engine.start() }
        if !playerNode.isPlaying { playerNode.play() }
        playerNode.scheduleBuffer(buffer, at: nil, options: []) { [weak self] in
            Task { @MainActor [weak self] in self?.clipFinished(epoch: epoch) }
        }
    }

    /// The run reached a terminal event (`done` / `cancelled`). If clips are still draining we
    /// wait for the queue to empty; if none were produced (a silent or cancelled run) we return
    /// to listening immediately and flush any utterance captured during barge-in.
    func runCompleted() {
        runActive = false
        guard isOn else { return }
        if anyClipEnqueued && clipsPending > 0 {
            // Still speaking — let the queue drain; the last clip's completion returns to listening.
            runDoneWaitingForDrain = true
        } else {
            anyClipEnqueued = false
            runDoneWaitingForDrain = false
            returnToListeningAfterRun()
        }
    }

    // MARK: - Capture lifecycle

    private func resetCapture() {
        captured = []
        // Pre-size to a whole max-length utterance (16 kHz mono Int16) so a long capture doesn't
        // repeatedly realloc the array as ~16 frames/sec append over many seconds.
        captured.reserveCapacity(Int(maxUtterance * wireSampleRate))
        trailingSilence = 0
        speechStarted = false
        capturedDuration = 0
    }

    /// Process one already-converted tap frame: run the VAD on its RMS, append the 16 kHz mono
    /// Int16 `samples` while speech is active, and end the utterance after enough trailing silence.
    /// The realtime tap does the (non-Sendable buffer) conversion; the main actor only sees the
    /// Sendable extracted values.
    private func handleFrame(samples: [Int16], rms: Float, frameDuration: TimeInterval) {
        // Listen while listening/capturing AND while speaking (for barge-in): voice processing
        // (AEC) removes Alfred's own playback from the mic, so a frame over the threshold during
        // `speaking` is the USER talking over him. `thinking` ignores input (the utterance is in
        // flight, and the next can't post until it completes — runs serialize, §7.6).
        guard phase == .listening || phase == .capturing || phase == .speaking else {
            inputLevel = 0
            return
        }
        inputLevel = rms

        let voiced = rms >= energyThreshold

        if voiced {
            if phase == .speaking {
                // Barge-in: the user is talking over Alfred → stop playback and start capturing.
                // The interrupted run finishes server-side (spec: stop playback only).
                stopPlayback()
                phase = .capturing
                resetCapture()
            } else if phase == .listening {
                phase = .capturing
                resetCapture()
            }
            speechStarted = true
            trailingSilence = 0
        }

        if phase == .capturing {
            captured.append(contentsOf: samples)
            capturedDuration += frameDuration
            if !voiced && speechStarted {
                trailingSilence += frameDuration
            }
            if capturedDuration >= maxUtterance {
                endUtterance()
            } else if speechStarted && trailingSilence >= trailingSilenceToEnd {
                endUtterance()
            }
        }
    }

    /// The VAD declared end-of-utterance. Encode the captured PCM to WAV and upload (or queue it
    /// behind an in-flight run for the barge-in case). Too-short captures are discarded.
    private func endUtterance() {
        let samples = captured
        let duration = Double(samples.count) / wireSampleRate
        resetCapture()

        guard duration >= minUtterance, !samples.isEmpty else {
            phase = .listening
            return
        }

        let wav = Self.wavData(fromInt16: samples, sampleRate: Int(wireSampleRate))

        if runActive {
            // Barge-in: a run is still in flight. Hold this utterance; runs serialize, so post it
            // once the active run terminates (runCompleted → flushPending).
            pendingUtterance = wav
            phase = .thinking
            return
        }

        phase = .thinking
        upload(wav)
    }

    /// Upload a WAV utterance and let the existing event stream carry the resulting run.
    private func upload(_ wav: Data) {
        runActive = true
        anyClipEnqueued = false
        Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await self.transport.uploadAudio(
                    conversationId: self.conversationId, wavData: wav
                )
                // Optimistically show what Alfred heard; the durable message arrives on history
                // reload like any text turn.
                let text = result.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty { self.onTranscript(text) }
                // Stay in `thinking`; the SSE stream now carries the run (tts_audio → speaking,
                // done → runCompleted).
            } catch AlfredError.emptyTranscript {
                // Silence/noise — nothing was posted server-side; resume listening.
                self.runActive = false
                self.returnToListeningAfterRun()
            } catch AlfredError.busy {
                // The conversation is already busy (e.g. a text run in flight). Drop this
                // utterance; the active run will complete and we'll listen again.
                self.runActive = false
                self.returnToListeningAfterRun()
            } catch {
                self.runActive = false
                self.errorMessage = error.localizedDescription
                self.returnToListeningAfterRun()
            }
        }
    }

    /// After a run completes (or an upload failed), post a barge-in utterance held back during the
    /// run, otherwise resume listening.
    private func returnToListeningAfterRun() {
        guard isOn else { return }
        if let wav = pendingUtterance {
            pendingUtterance = nil
            phase = .thinking
            upload(wav)
        } else {
            phase = .listening
        }
    }

    // MARK: - Audio session / engine

    private func requestMicPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    private func configureSession() throws {
        let session = AVAudioSession.sharedInstance()
        // playAndRecord so we can capture and play simultaneously; .voiceChat mode pairs with the
        // input node's voice processing (AEC) and routes correctly over Bluetooth HFP;
        // defaultToSpeaker + allowBluetooth for a usable hands-free experience on any route.
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetoothHFP, .allowBluetoothA2DP]
        )
        try session.setActive(true, options: [])
    }

    private func startEngine() throws {
        // Attach the playback node + enable voice processing ONCE. The rest of the graph (player
        // connection + input tap) is built by rebuildAndStart, which also runs on every audio
        // configuration change.
        engine.attach(playerNode)
        // Apple AEC + noise suppression on the input node. Its echo canceller removes Alfred's
        // playback (rendered through this same engine) from the mic, so the user can talk over him
        // (barge-in) and the built-in-speaker case doesn't feed back. Must be set before start.
        try engine.inputNode.setVoiceProcessingEnabled(true)
        try rebuildAndStart()
    }

    /// (Re)build the engine graph and start it. Runs at first start AND on every
    /// AVAudioEngineConfigurationChange — a route change (e.g. a Bluetooth HFP link engaging)
    /// stops the engine and invalidates the input tap, so the connection + tap must be rebuilt
    /// against the (possibly new) formats or the mic silently stops delivering frames.
    private func rebuildAndStart() throws {
        if engine.isRunning { engine.stop() }
        engine.connect(playerNode, to: engine.mainMixerNode, format: playbackFormat)
        try installInputTap()
        engine.prepare()
        try engine.start()
    }

    /// Install (or reinstall) the mic tap, building a fresh converter for the input node's current
    /// format. Removes any prior tap first so a rebuild after a route change can't double-install.
    private func installInputTap() throws {
        let input = engine.inputNode
        let hwFormat = input.outputFormat(forBus: 0)
        guard
            hwFormat.sampleRate > 0,
            let wireFloatFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: wireSampleRate, channels: 1, interleaved: false
            ),
            let converter = AVAudioConverter(from: hwFormat, to: wireFloatFormat)
        else {
            throw VoiceError.audioFormat
        }
        let ratio = wireSampleRate / hwFormat.sampleRate
        input.removeTap(onBus: 0)
        // The converter + wire format are captured by the realtime tap closure (not stored on the
        // actor), so the non-Sendable buffer never crosses to the main actor — only the Sendable
        // extracted values ([Int16], Float) do.
        input.installTap(onBus: 0, bufferSize: 2_048, format: hwFormat) { [weak self] buffer, _ in
            guard
                let (samples, rms) = Self.convertFrame(
                    buffer, converter: converter, wireFormat: wireFloatFormat, ratio: ratio
                )
            else { return }
            let frameDuration = buffer.format.sampleRate > 0
                ? Double(buffer.frameLength) / buffer.format.sampleRate
                : 0
            Task { @MainActor [weak self] in
                self?.handleFrame(samples: samples, rms: rms, frameDuration: frameDuration)
            }
        }
    }

    /// Observe engine reconfigurations (route changes / Bluetooth) and rebuild — see rebuildAndStart.
    private func observeConfigurationChanges() {
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.handleConfigurationChange() }
        }
    }

    private func handleConfigurationChange() {
        guard isOn else { return }
        // The engine was stopped by the system and formats may have changed; drop in-flight
        // playback and rebuild. A reply being spoken when the route flips is lost (rare); the run
        // still completes server-side and its terminal event returns us to listening.
        stopPlayback()
        do {
            try rebuildAndStart()
        } catch {
            errorMessage = "Audio route changed; couldn't restart voice."
            stop()
            return
        }
        resetCapture()
        // Resume listening unless a run is still in flight (its terminal event will resume us).
        if !runActive || phase == .capturing { phase = .listening }
    }

    private func teardownAudio() {
        if let observer = configObserver {
            NotificationCenter.default.removeObserver(observer)
            configObserver = nil
        }
        if engine.isRunning {
            engine.stop()
        }
        engine.inputNode.removeTap(onBus: 0)
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    // MARK: - Playback

    /// One clip's playback (or failed fetch) settled. When the last pending clip clears and the run
    /// has terminated, return to listening; otherwise keep speaking (more clips arriving). A
    /// stale-epoch completion (from a barged-into run) is ignored — stopPlayback already reset the count.
    private func clipFinished(epoch: Int) {
        guard epoch == playbackEpoch else { return }
        if clipsPending > 0 { clipsPending -= 1 }
        guard isOn else { return }
        if clipsPending == 0 && (runDoneWaitingForDrain || !runActive) {
            anyClipEnqueued = false
            runDoneWaitingForDrain = false
            returnToListeningAfterRun()
        }
    }

    /// Stop and clear playback (barge-in or full stop). Bumps the epoch so in-flight downloads and
    /// the completion handlers of already-scheduled buffers are ignored.
    private func stopPlayback() {
        playbackEpoch += 1
        if playerNode.isPlaying { playerNode.stop() }
        clipsPending = 0
        anyClipEnqueued = false
        runDoneWaitingForDrain = false
    }

    /// Decode encoded audio (the WAV/MP3 served from /media) into a PCM buffer in `format`. Writes
    /// to a temp file (AVAudioFile needs a URL), reads it, and resamples/converts to the player
    /// node's connection format when the clip's native format differs. Returns nil on any failure.
    private nonisolated static func decodeToBuffer(_ data: Data, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".audio")
        defer { try? FileManager.default.removeItem(at: tmp) }
        do {
            try data.write(to: tmp)
            let file = try AVAudioFile(forReading: tmp)
            let srcFormat = file.processingFormat
            let frames = AVAudioFrameCount(file.length)
            guard frames > 0, let srcBuffer = AVAudioPCMBuffer(pcmFormat: srcFormat, frameCapacity: frames) else {
                return nil
            }
            try file.read(into: srcBuffer)
            if srcFormat == format { return srcBuffer }

            // Native format differs (e.g. ElevenLabs MP3 at 44.1 kHz) — convert to the node format.
            guard let converter = AVAudioConverter(from: srcFormat, to: format) else { return nil }
            let ratio = format.sampleRate / srcFormat.sampleRate
            let outCapacity = AVAudioFrameCount(Double(srcBuffer.frameLength) * ratio + 1024)
            guard outCapacity > 0, let outBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: outCapacity) else {
                return nil
            }
            var fed = false
            var convError: NSError?
            let status = converter.convert(to: outBuffer, error: &convError) { _, outStatus in
                if fed { outStatus.pointee = .noDataNow; return nil }
                fed = true
                outStatus.pointee = .haveData
                return srcBuffer
            }
            guard status != .error, convError == nil else { return nil }
            return outBuffer
        } catch {
            return nil
        }
    }

    // MARK: - PCM → wire format (realtime thread)

    /// Convert one hardware-format buffer to 16 kHz mono Int16 and compute its RMS in one pass.
    /// Runs on the realtime audio thread — returns Sendable values (`[Int16]`, `Float`) so the
    /// non-Sendable `AVAudioPCMBuffer` never crosses to the main actor. Returns nil on failure.
    private nonisolated static func convertFrame(
        _ buffer: AVAudioPCMBuffer,
        converter: AVAudioConverter,
        wireFormat: AVAudioFormat,
        ratio: Double
    ) -> ([Int16], Float)? {
        let outCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 16)
        guard outCapacity > 0,
              let out = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: outCapacity) else {
            return nil
        }

        var fed = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, outStatus in
            if fed {
                outStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            outStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, error == nil, let channel = out.floatChannelData?[0] else { return nil }

        let n = Int(out.frameLength)
        guard n > 0 else { return ([], 0) }
        var samples = [Int16]()
        samples.reserveCapacity(n)
        var sum: Float = 0
        for i in 0..<n {
            let s = channel[i]
            sum += s * s
            let clamped = max(-1.0, min(1.0, s))
            samples.append(Int16(clamped * Float(Int16.max)))
        }
        let rms = (sum / Float(n)).squareRoot()
        return (samples, rms)
    }

    // MARK: - WAV container

    /// Wrap raw 16 kHz mono signed-16-bit LINEAR16 PCM in a minimal WAV (RIFF) container — no
    /// transcoding dependency, mirroring the backend's PCM→WAV wrapping.
    private static func wavData(fromInt16 samples: [Int16], sampleRate: Int) -> Data {
        let channels = 1
        let bitsPerSample = 16
        let byteRate = sampleRate * channels * bitsPerSample / 8
        let blockAlign = channels * bitsPerSample / 8
        let dataSize = samples.count * bitsPerSample / 8

        var data = Data()
        func appendString(_ s: String) { data.append(contentsOf: Array(s.utf8)) }
        func appendUInt32LE(_ v: UInt32) {
            data.append(UInt8(v & 0xff))
            data.append(UInt8((v >> 8) & 0xff))
            data.append(UInt8((v >> 16) & 0xff))
            data.append(UInt8((v >> 24) & 0xff))
        }
        func appendUInt16LE(_ v: UInt16) {
            data.append(UInt8(v & 0xff))
            data.append(UInt8((v >> 8) & 0xff))
        }

        appendString("RIFF")
        appendUInt32LE(UInt32(36 + dataSize))
        appendString("WAVE")
        appendString("fmt ")
        appendUInt32LE(16)                       // PCM fmt chunk size
        appendUInt16LE(1)                        // audio format = PCM
        appendUInt16LE(UInt16(channels))
        appendUInt32LE(UInt32(sampleRate))
        appendUInt32LE(UInt32(byteRate))
        appendUInt16LE(UInt16(blockAlign))
        appendUInt16LE(UInt16(bitsPerSample))
        appendString("data")
        appendUInt32LE(UInt32(dataSize))
        samples.withUnsafeBufferPointer { ptr in
            ptr.baseAddress?.withMemoryRebound(to: UInt8.self, capacity: dataSize) { bytes in
                data.append(bytes, count: dataSize)
            }
        }
        return data
    }
}

/// Errors from voice setup that warrant surfacing to the owner.
nonisolated enum VoiceError: Error, LocalizedError {
    case audioFormat

    var errorDescription: String? {
        switch self {
        case .audioFormat:
            return "Couldn't set up audio capture on this device."
        }
    }
}
