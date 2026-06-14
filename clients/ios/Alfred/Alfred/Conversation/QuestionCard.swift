//
//  QuestionCard.swift
//  Alfred
//
//  The agent-initiated question prompt (ask_user, §7.3): the owner answers with a single
//  option (radios), multiple options (checkboxes), and/or a free-text "Other". Mirrors the
//  web client's rules — with options present, the free text is an explicit "Other" choice
//  (mutually exclusive with options in single-select); with no options it IS the answer.
//

import SwiftUI

struct QuestionCard: View {
    let prompt: QuestionPrompt
    /// Submit the answer: the picked option labels and (when active) the free text.
    let onSubmit: (_ selectedLabels: [String], _ freeformText: String?) -> Void

    /// Multi-select picks: an array. Single-select uses `single` (one value XOR "Other") instead,
    /// so we don't maintain a 0-or-1 array by hand across the helpers.
    @State private var selected: [String] = []
    @State private var single: String?
    @State private var freeform = ""
    /// Whether the "Other" free-text choice is selected (only meaningful when options exist).
    @State private var otherSelected = false

    private var options: [QuestionOption] { prompt.options ?? [] }
    private var hasOptions: Bool { !options.isEmpty }
    private var multi: Bool { prompt.multiSelect == true }
    private var allowFreeform: Bool { prompt.allowFreeform != false }

    /// The free text counts only when it's the active choice: a pure free-form question
    /// (no options) or the "Other" option is selected.
    private var otherActive: Bool { !hasOptions || otherSelected }

    /// Whether a listed option is picked — the array in multi-select, `single` otherwise.
    private func isPicked(_ label: String) -> Bool {
        multi ? selected.contains(label) : single == label
    }

    /// The picked option labels for submission.
    private var pickedLabels: [String] {
        multi ? selected : (single.map { [$0] } ?? [])
    }

    private var canSubmit: Bool {
        !pickedLabels.isEmpty || (otherActive && !freeform.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(prompt.question)
                .font(.headline)

            if hasOptions {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(options, id: \.label) { opt in
                        optionRow(opt)
                    }
                    if allowFreeform {
                        otherRow
                    }
                }
            } else if allowFreeform {
                TextField("Type an answer…", text: $freeform, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...4)
            }

            Button("Submit") { submit() }
                .buttonStyle(.borderedProminent)
                .disabled(!canSubmit)
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Color.accentColor.opacity(0.4))
        )
    }

    // MARK: - Rows

    private func optionRow(_ opt: QuestionOption) -> some View {
        Button {
            toggleOption(opt.label)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: selectionSymbol(isOn: isPicked(opt.label)))
                    .foregroundStyle(isPicked(opt.label) ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(opt.label)
                        .foregroundStyle(.primary)
                    if let description = opt.description {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var otherRow: some View {
        HStack(alignment: .top, spacing: 10) {
            Button {
                toggleOther()
            } label: {
                Image(systemName: selectionSymbol(isOn: otherSelected))
                    .foregroundStyle(otherSelected ? Color.accentColor : .secondary)
            }
            .buttonStyle(.plain)
            TextField("Type your own answer…", text: $freeform, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
                .onChange(of: freeform) { _, newValue in
                    if !newValue.isEmpty { ensureOther() }
                }
        }
    }

    private func selectionSymbol(isOn: Bool) -> String {
        if multi {
            return isOn ? "checkmark.square.fill" : "square"
        }
        return isOn ? "largecircle.fill.circle" : "circle"
    }

    // MARK: - Selection logic (mirrors web Chat.tsx)

    /// Pick a listed option. Single-select sets the lone selection and clears "Other" (exclusive);
    /// multi-select toggles it and leaves "Other" alone.
    private func toggleOption(_ label: String) {
        if multi {
            if let idx = selected.firstIndex(of: label) {
                selected.remove(at: idx)
            } else {
                selected.append(label)
            }
        } else {
            single = label
            otherSelected = false
        }
    }

    /// The "Other" choice: single-select makes it exclusive (clears any picked option);
    /// multi-select toggles it alongside the options.
    private func toggleOther() {
        if multi {
            otherSelected.toggle()
        } else {
            otherSelected = true
            single = nil
        }
    }

    /// Typing in the free-text box selects "Other" (never deselects); single-select clears the option.
    private func ensureOther() {
        otherSelected = true
        if !multi { single = nil }
    }

    private func submit() {
        guard canSubmit else { return }
        let text = otherActive
            ? freeform.trimmingCharacters(in: .whitespacesAndNewlines)
            : ""
        onSubmit(pickedLabels, text.isEmpty ? nil : text)
    }
}
