//
//  ApprovalCard.swift
//  Alfred
//
//  The in-app approval prompt (ARCHITECTURE §16): the owner sees the proposed action with
//  its full args and approves or declines before the worker runs the tool. A "Don't ask
//  again" toggle persists the decision (remember), with a confirm guard before disabling
//  approval on a destructive tool — mirroring the web client.
//

import SwiftUI

struct ApprovalCard: View {
    let prompt: ApprovalPrompt
    /// Resolve the interaction. `remember` persists the decision (require_approval=false).
    let onResolve: (_ approved: Bool, _ remember: Bool) -> Void

    @State private var remember = false
    @State private var showDestructiveConfirm = false

    private var isGroup: Bool { prompt.scope == "group" }
    private var isDestructive: Bool { prompt.trustTier == "destructive" }
    private var toolName: String { prompt.tool ?? "this tool" }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(prompt.summary ?? "Approve action")
                .font(.headline)

            if isGroup {
                Text("Covers all of this task's actions — you won't be asked again until the run finishes. First action shown below.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            if let tool = prompt.tool {
                HStack(spacing: 6) {
                    Text("Tool:")
                        .foregroundStyle(.secondary)
                    Text(tool)
                        .font(.body.monospaced())
                        .foregroundStyle(Color.accentColor)
                }
                .font(.subheadline)
            }

            if let pretty = prettyArgs {
                ScrollView {
                    Text(pretty)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 180)
                .padding(10)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }

            Toggle(isOn: $remember) {
                Text(isGroup
                     ? "Don't ask again for these actions"
                     : "Don't ask again for \(toolName)")
                    .font(.subheadline)
            }

            HStack(spacing: 12) {
                Button("Approve") { approve() }
                    .buttonStyle(.borderedProminent)
                Button("Decline", role: .cancel) { onResolve(false, false) }
                    .buttonStyle(.bordered)
            }
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Color.accentColor.opacity(0.4))
        )
        .confirmationDialog(
            "Stop asking for approval on \"\(toolName)\"?",
            isPresented: $showDestructiveConfirm,
            titleVisibility: .visible
        ) {
            Button("Approve and don't ask again", role: .destructive) {
                onResolve(true, true)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("It can take destructive actions, and Alfred will run it without checking from now on.")
        }
    }

    private func approve() {
        // Guard before persisting "never ask" on a destructive tool (web parity).
        if remember && isDestructive {
            showDestructiveConfirm = true
        } else {
            onResolve(true, remember)
        }
    }

    /// Pretty-print the args object as indented JSON for display.
    private var prettyArgs: String? {
        guard let args = prompt.args else { return nil }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard
            let data = try? encoder.encode(args),
            let s = String(data: data, encoding: .utf8)
        else {
            return args.summary
        }
        return s
    }
}
