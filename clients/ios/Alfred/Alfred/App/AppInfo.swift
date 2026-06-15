//
//  AppInfo.swift
//  Alfred
//
//  The app's own version, read from the bundle. This is the Xcode build version
//  (CFBundleShortVersionString + CFBundleVersion) — not the backend's git-describe
//  APP_VERSION surfaced via /api/health.
//

import Foundation

enum AppInfo {
    /// `"<CFBundleShortVersionString> (<CFBundleVersion>)"`, each defaulting to "?" if absent.
    static var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(short) (\(build))"
    }
}
