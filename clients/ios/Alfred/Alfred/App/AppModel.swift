//
//  AppModel.swift
//  Alfred
//
//  The app-wide composition root: settings, the API client, and the notification
//  manager, wired together once and injected into the view tree via @Environment.
//

import Foundation

@MainActor
@Observable
final class AppModel {
    let settings: SettingsStore
    let client: AlfredClient
    let notifications: NotificationManager

    init() {
        let settings = SettingsStore()
        self.settings = settings
        // Resolve the base URL off-actor via the nonisolated UserDefaults-backed resolver — the
        // client's non-isolated request/stream tasks invoke this provider off the main actor.
        self.client = AlfredClient(baseURLProvider: { [settings] in settings.resolvedBaseURL })
        self.notifications = NotificationManager()
    }
}
