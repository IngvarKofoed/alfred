//
//  RootView.swift
//  Alfred
//
//  The root navigation shell: a stack with the conversation list at its root,
//  pushing a ConversationView per conversation id. The toolbar opens Settings in
//  a sheet and mints a fresh conversation. Notification authorization is requested
//  once on first appear.
//

import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var appModel

    @State private var path: [String] = []
    @State private var showingSettings = false
    @State private var didRequestAuthorization = false

    var body: some View {
        NavigationStack(path: $path) {
            ConversationListView(
                onOpen: { id in path.append(id) },
                onNew: { path.append(UUID().uuidString.lowercased()) }
            )
            .navigationTitle("Alfred")
            .navigationDestination(for: String.self) { conversationId in
                ConversationView(conversationId: conversationId)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showingSettings = true
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        path.append(UUID().uuidString.lowercased())
                    } label: {
                        Label("New conversation", systemImage: "square.and.pencil")
                    }
                }
            }
        }
        .sheet(isPresented: $showingSettings) {
            NavigationStack {
                SettingsView()
            }
        }
        .task {
            guard !didRequestAuthorization else { return }
            didRequestAuthorization = true
            await appModel.notifications.requestAuthorization()
        }
    }
}
