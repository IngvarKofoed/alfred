//
//  SettingsView.swift
//  Alfred
//
//  Server connection settings. The only thing to configure is the base URL —
//  the Tailscale MagicDNS HTTPS host that `tailscale serve` exposes. There is no
//  login (network position is the auth, ARCHITECTURE §12).
//

import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        // Bindable so the TextField can two-way bind to the @Observable store.
        @Bindable var settings = app.settings

        NavigationStack {
            Form {
                Section {
                    TextField(
                        "https://alfred.tail-scale.ts.net",
                        text: $settings.baseURLString
                    )
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textContentType(.URL)
                    .submitLabel(.done)
                } header: {
                    Text("Server")
                } footer: {
                    resolvedFooter
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private var resolvedFooter: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Enter the Tailscale MagicDNS HTTPS host for your Alfred home server, for example https://alfred.your-tailnet.ts.net. Your iPhone reaches it over the tailnet.")

            if app.settings.isURLBlank {
                Label("No server configured", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.secondary)
            } else if let url = app.settings.baseURL {
                Label {
                    Text("Connecting to \(Text(url.absoluteString).bold())")
                } icon: {
                    Image(systemName: "checkmark.circle")
                }
                .foregroundStyle(.green)
            } else {
                Label("Invalid URL — use a full http(s) address with a host", systemImage: "xmark.octagon")
                    .foregroundStyle(.red)
            }
        }
    }
}

#Preview {
    SettingsView()
        .environment(AppModel())
}
