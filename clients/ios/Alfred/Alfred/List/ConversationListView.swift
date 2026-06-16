//
//  ConversationListView.swift
//  Alfred
//
//  The history/list screen: the owner's recent conversations, newest-active first.
//  Tapping a row opens it; the toolbar (owned by RootView) mints a fresh conversation.
//  Mirrors the web client's sidebar (clients/web/src/Sidebar.tsx).
//

import SwiftUI

struct ConversationListView: View {
    let onOpen: (String) -> Void
    let onNew: () -> Void

    @Environment(AppModel.self) private var app
    @State private var viewModel: ConversationListViewModel?

    var body: some View {
        Group {
            if let viewModel {
                content(viewModel)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle("Conversations")
        .task {
            // Build the view model lazily so it captures the environment-provided client.
            let vm = viewModel ?? ConversationListViewModel(client: app.client)
            viewModel = vm
            await vm.load()
        }
    }

    @ViewBuilder
    private func content(_ viewModel: ConversationListViewModel) -> some View {
        if viewModel.conversations.isEmpty {
            emptyOrError(viewModel)
        } else {
            List {
                ForEach(viewModel.conversations) { conversation in
                    Button {
                        onOpen(conversation.id)
                    } label: {
                        ConversationRow(conversation: conversation)
                    }
                    .buttonStyle(.plain)
                }
            }
            .listStyle(.plain)
            .refreshable { await viewModel.load() }
        }
    }

    @ViewBuilder
    private func emptyOrError(_ viewModel: ConversationListViewModel) -> some View {
        VStack(spacing: 12) {
            if let loadError = viewModel.loadError {
                Image(systemName: "exclamationmark.triangle")
                    .font(.largeTitle)
                    .foregroundStyle(.secondary)
                Text(loadError)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                Button("Retry") {
                    Task { await viewModel.load() }
                }
                .buttonStyle(.bordered)
            } else {
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(.largeTitle)
                    .foregroundStyle(.secondary)
                Text("No conversations yet.")
                    .foregroundStyle(.secondary)
                Button("New conversation", action: onNew)
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Row

private struct ConversationRow: View {
    let conversation: ConversationSummary

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(conversation.title ?? "New conversation")
                    .font(.body)
                    .foregroundStyle(conversation.title == nil ? .secondary : .primary)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    if let badge = ingressBadge(conversation.ingress) {
                        Text(badge)
                            .font(.caption2)
                            .textCase(.uppercase)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(Color.secondary.opacity(0.15), in: Capsule())
                            .foregroundStyle(.secondary)
                    }
                    if let relative = relativeTime(conversation.lastActiveAt) {
                        Text(relative)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
        .padding(.vertical, 4)
    }
}

// A small tag for non-web ingresses so a watcher / Discord / voice thread is distinguishable in
// the unified list. "web" (and absent) shows none.
private func ingressBadge(_ ingress: String?) -> String? {
    switch ingress {
    case "trigger": return "watcher"
    case "discord": return "discord"
    case "voice": return "voice"
    default: return nil
    }
}

// MARK: - Relative time

private let isoFractional: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

private let isoPlain: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

private let relativeFormatter: RelativeDateTimeFormatter = {
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .abbreviated
    return f
}()

/// Parse an ISO-8601 timestamp tolerant of fractional seconds (the server emits e.g.
/// "2026-06-14T10:08:00.123Z"), falling back to the no-fraction variant. nil if absent/unparseable.
private func parseISO(_ iso: String?) -> Date? {
    guard let iso else { return nil }
    return isoFractional.date(from: iso) ?? isoPlain.date(from: iso)
}

/// Render a compact relative string (e.g. "3m ago") for an ISO timestamp; returns nil when the
/// string is absent or unparseable, so the row simply shows no timestamp.
private func relativeTime(_ iso: String?) -> String? {
    guard let date = parseISO(iso) else { return nil }
    return relativeFormatter.localizedString(for: date, relativeTo: Date())
}
