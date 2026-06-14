//
//  NotificationManager.swift
//  Alfred
//
//  Local notifications for backgrounded approvals/questions. Best-effort: if the app is
//  fully suspended the SSE stream is paused and this never fires (that needs push, out of
//  scope). Only posts while the app is not active.
//

import Foundation
import UserNotifications
import UIKit

@MainActor
final class NotificationManager {
    private let center = UNUserNotificationCenter.current()

    init() {}

    /// Ask for alert/sound authorization. Safe to call repeatedly; ignores the result.
    func requestAuthorization() async {
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    }

    /// Post a local notification for a pending interaction, only when the app is not
    /// foreground-active. Carries the conversation id in userInfo so a tap can route back.
    func notifyInteraction(kind: InteractionKind, conversationId: String) {
        guard UIApplication.shared.applicationState != .active else { return }

        let content = UNMutableNotificationContent()
        switch kind {
        case .approval:
            content.title = "Alfred needs approval"
            content.body = "A run is waiting for you to approve an action."
        case .question:
            content.title = "Alfred has a question"
            content.body = "A run is waiting for your answer."
        }
        content.sound = .default
        content.userInfo = ["conversationId": conversationId, "kind": kind.rawValue]

        let request = UNNotificationRequest(
            identifier: "interaction-\(conversationId)-\(UUID().uuidString)",
            content: content,
            trigger: nil // deliver immediately
        )
        center.add(request, withCompletionHandler: nil)
    }
}
