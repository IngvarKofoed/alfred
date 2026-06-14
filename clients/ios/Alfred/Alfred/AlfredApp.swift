//
//  AlfredApp.swift
//  Alfred
//
//  Created by Martin Ingvar Kofoed Jensen on 14/06/2026.
//

import SwiftUI

@main
struct AlfredApp: App {
    @State private var appModel = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appModel)
        }
    }
}
