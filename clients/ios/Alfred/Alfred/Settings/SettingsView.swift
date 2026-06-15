//
//  SettingsView.swift
//  Alfred
//
//  Server connection settings. The owner keeps a list of saved servers (each a labelled
//  base URL — the Tailscale MagicDNS HTTPS host that `tailscale serve` exposes), picks the
//  active one, and can test each by hitting GET /api/health. There is no login (network
//  position is the auth, ARCHITECTURE §12). The active server's URL is written through to the
//  legacy `alfred.baseURL` key by the store, so AlfredClient's resolve path is untouched.
//

import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    /// Transient, per-server connection-test results, keyed by server id. Not persisted — a test
    /// is a point-in-time probe, re-run on demand (a row's result persists for the session until
    /// the next Test tap on it).
    @State private var testResults: [UUID: TestResult] = [:]

    // Add-server form fields.
    @State private var newLabel = ""
    @State private var newURL = ""

    /// The server currently being edited (drives the edit sheet), or nil when none.
    @State private var editingServer: Server?

    /// The result of a per-server connection test.
    private enum TestResult: Equatable {
        case idle
        case testing
        case ok(String?)        // optional server version string
        case failed(String)     // short failure line
    }

    var body: some View {
        // Bindable so the TextFields can two-way bind to the @Observable store.
        @Bindable var settings = app.settings

        NavigationStack {
            Form {
                serversSection(settings)
                addSection(settings)
                aboutSection
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(item: $editingServer) { server in
                EditServerSheet(server: server) { label, urlString in
                    settings.updateServer(id: server.id, label: label, urlString: urlString)
                    // The URL may have changed — drop the now-stale connection-test result.
                    testResults[server.id] = nil
                }
            }
        }
    }

    // MARK: - Servers

    @ViewBuilder
    private func serversSection(_ settings: SettingsStore) -> some View {
        Section {
            if settings.servers.isEmpty {
                Label("No servers yet — add one below.", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(settings.servers) { server in
                    serverRow(server, settings)
                }
            }
        } header: {
            Text("Servers")
        } footer: {
            Text("Tap a server to make it active; swipe a row to edit or delete it. Alfred uses the active server for all requests.")
        }
    }

    @ViewBuilder
    private func serverRow(_ server: Server, _ settings: SettingsStore) -> some View {
        let isActive = server.id == settings.activeServerID
        let (url, isInvalid) = serverURLValidity(server.urlString)

        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Button {
                    settings.activate(id: server.id)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: isActive ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(isActive ? Color.accentColor : Color.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(displayName(for: server, url: url))
                                    .font(.body)
                                if isActive {
                                    Text("Active")
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(Color.accentColor)
                                }
                            }
                            Text(server.urlString)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .buttonStyle(.plain)
                .contentShape(Rectangle())

                Spacer()

                testControl(server, url: url)
            }

            if isInvalid {
                InvalidURLLabel().font(.caption)
            }

            switch testResults[server.id] ?? .idle {
            case .idle, .testing:
                EmptyView()
            case .ok(let version):
                Label(version.map { "Reachable · \($0)" } ?? "Reachable", systemImage: "checkmark.seal.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
            case .failed(let message):
                Label(message, systemImage: "xmark.octagon.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) {
                settings.deleteServer(id: server.id)
                testResults[server.id] = nil
            } label: {
                Label("Delete", systemImage: "trash")
            }
            Button {
                editingServer = server
            } label: {
                Label("Edit", systemImage: "pencil")
            }
            .tint(.accentColor)
        }
    }

    /// The per-row Test affordance: a spinner while in flight, otherwise a tappable button.
    @ViewBuilder
    private func testControl(_ server: Server, url: URL?) -> some View {
        if testResults[server.id] == .testing {
            ProgressView()
                .controlSize(.small)
        } else {
            Button("Test") {
                Task { await test(server, url: url) }
            }
            .buttonStyle(.borderless)
            .disabled(url == nil)
        }
    }

    private func displayName(for server: Server, url: URL?) -> String {
        let label = server.label.trimmingCharacters(in: .whitespacesAndNewlines)
        if !label.isEmpty { return label }
        return url?.host ?? server.urlString
    }

    private func test(_ server: Server, url: URL?) async {
        guard let url else { return }
        testResults[server.id] = .testing
        do {
            let health = try await app.client.health(for: url)
            // Treat a well-formed but not-ok health response as a soft failure.
            if health.ok {
                testResults[server.id] = .ok(health.version)
            } else {
                testResults[server.id] = .failed("Server reported not ready")
            }
        } catch {
            testResults[server.id] = .failed(error.localizedDescription)
        }
    }

    // MARK: - Add a server

    @ViewBuilder
    private func addSection(_ settings: SettingsStore) -> some View {
        let (validURL, isInvalid) = serverURLValidity(newURL)

        Section {
            serverFields(label: $newLabel, url: $newURL)

            Button("Add") {
                settings.addServer(label: newLabel, urlString: newURL)
                newLabel = ""
                newURL = ""
            }
            .disabled(validURL == nil)
        } header: {
            Text("Add a server")
        } footer: {
            VStack(alignment: .leading, spacing: 8) {
                Text("Enter the Tailscale MagicDNS HTTPS host for an Alfred home server, for example https://alfred.your-tailnet.ts.net. Your iPhone reaches it over the tailnet.")
                if isInvalid {
                    InvalidURLLabel()
                }
            }
        }
    }

    // MARK: - About

    @ViewBuilder
    private var aboutSection: some View {
        Section {
            LabeledContent("Version", value: "Alfred for iOS \(AppInfo.version)")
            if let active = app.settings.activeServer,
               case .ok(let version?) = testResults[active.id] {
                LabeledContent("Active server (last test)", value: version)
            }
        } header: {
            Text("About")
        }
    }
}

/// A sheet to edit a saved server's label + URL. Prefilled from the server; Save is disabled
/// until the URL validates. The parent applies the change via SettingsStore.updateServer.
private struct EditServerSheet: View {
    let server: Server
    let onSave: (String, String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var label: String
    @State private var urlString: String

    init(server: Server, onSave: @escaping (String, String) -> Void) {
        self.server = server
        self.onSave = onSave
        _label = State(initialValue: server.label)
        _urlString = State(initialValue: server.urlString)
    }

    var body: some View {
        let (validURL, isInvalid) = serverURLValidity(urlString)
        NavigationStack {
            Form {
                Section {
                    serverFields(label: $label, url: $urlString)
                } footer: {
                    if isInvalid { InvalidURLLabel() }
                }
            }
            .navigationTitle("Edit Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(label, urlString)
                        dismiss()
                    }
                    .disabled(validURL == nil)
                }
            }
        }
    }
}

/// The label + URL text fields shared by the add form and the edit sheet, so their input
/// configuration (keyboard, autocaps, content type) can't drift between the two.
@ViewBuilder
private func serverFields(label: Binding<String>, url: Binding<String>) -> some View {
    TextField("Label (optional)", text: label)
        .textInputAutocapitalization(.words)
    TextField("https://alfred.your-tailnet.ts.net", text: url)
        .keyboardType(.URL)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .textContentType(.URL)
        .submitLabel(.done)
}

/// The single URL rule behind the per-row, add-form, and edit-sheet indicators: the validated URL
/// (nil if not a valid http(s)+host address) and whether the string is "invalid" — non-blank but
/// unparseable.
private func serverURLValidity(_ urlString: String) -> (url: URL?, isInvalid: Bool) {
    let url = SettingsStore.validatedURL(from: urlString)
    let isBlank = urlString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    return (url, url == nil && !isBlank)
}

/// The shared "this URL is malformed" caption, used under a server row, the add form, and the edit sheet.
private struct InvalidURLLabel: View {
    var body: some View {
        Label("Invalid URL — use a full http(s) address with a host", systemImage: "xmark.octagon")
            .foregroundStyle(.red)
    }
}

#Preview {
    SettingsView()
        .environment(AppModel())
}
