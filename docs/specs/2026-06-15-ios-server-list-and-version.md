# iOS config: server list, connection test, and version

Two related additions to the iOS Settings page. (1) Replace the single base-URL field with a
**list of saved servers** — each a labelled base URL — that the owner can add, edit, delete,
switch between, and **test** (hit `GET /api/health` and show reachable + the server's version).
(2) Show the **app's own version** (and, after a test, the connected server's version) on the
page. The list is the new source of truth, but the active server's URL is *written through* to
the existing `alfred.baseURL` UserDefaults key, so `AlfredClient`'s per-call resolve path is
untouched.

## Key decisions

- **Server-list data model** (new). `Server { id: UUID, label: String, urlString: String }`;
  `SettingsStore` holds `servers: [Server]` + `activeServerID: UUID?`, persisted as JSON in two
  new UserDefaults keys (`alfred.servers`, `alfred.activeServerID`). Replaces the lone
  `baseURLString` as the page's source of truth.
- **Write-through to the legacy key** (extends). On any change to the active server (activate /
  edit-active / delete-active), the store writes the active server's `urlString` into the existing
  `alfred.baseURL` key. The nonisolated `resolvedBaseURL` reader and `AlfredClient` stay
  **byte-for-byte unchanged** — this is what keeps the network hot path (and its off-actor read)
  out of scope. An invalid/absent active server writes `""` → `resolvedBaseURL` is nil →
  `AlfredError.notConfigured`, exactly as a blank field behaves today.
- **Explicit-URL health check** (extends). New `AlfredClient.health(for url: URL) -> HealthResponse`
  (`{ ok: Bool, version: String? }`) that probes a *given* URL, bypassing `baseURLProvider` (you
  test a server before it's the active one). Reuses the existing path-prefix-preserving join logic
  (`url(_:)`), generalized to take an explicit base.
- **App version from the bundle** (new). A tiny `AppInfo.version` reads
  `CFBundleShortVersionString` + `CFBundleVersion` from `Bundle.main`. This is the Xcode build
  version, *not* the backend's git-describe `APP_VERSION` (which is TS-stack-only, surfaced via
  `/api/health`).
- **Test results are transient view state** (new). Per-server reachable/version/error lives in
  `SettingsView` `@State` (a dict keyed by server id), not persisted — a test is a point-in-time
  probe, re-run on demand.

## Goals

- Let the owner keep several Alfred servers (home box, laptop dev, …) and switch the active one.
- Confirm a server is reachable *before* relying on it, and see what version it's running.
- Show the iOS app's own version on the config page.

## Non-goals

- Per-server auth/secrets — network position is the auth (ARCHITECTURE §12); a server is just a URL.
- Syncing the server list across devices (it's local UserDefaults).
- Automatic server discovery / Bonjour / tailnet enumeration.
- Auto-probing health on Settings open, or a background reachability monitor — test is on tap.
- Forcing open views to tear down when the active server changes (switching takes effect on the
  next natural refresh).
- First-launch migration from the old single-URL `alfred.baseURL` key — handled manually by the
  owner, out of scope here.

## Design

### SettingsStore (`clients/ios/Alfred/Alfred/Settings/SettingsStore.swift`)

`@MainActor @Observable`, reshaped from a single string to the list model:

```swift
struct Server: Codable, Identifiable, Hashable { let id: UUID; var label: String; var urlString: String }

var servers: [Server]            // didSet → persist + syncActiveBaseURL()
var activeServerID: UUID?        // didSet → persist + syncActiveBaseURL()
var activeServer: Server? { servers.first { $0.id == activeServerID } }
```

- `syncActiveBaseURL()` writes `activeServer?.urlString ?? ""` to `alfred.baseURL` (the legacy key).
- `resolvedBaseURL` (nonisolated, reads `alfred.baseURL`) and `validatedURL(from:)` are **kept as
  is** — including the http(s)+host validation, which now guards the active server's URL.
- A per-server `validatedURL` is exposed for the view to show "valid / invalid / blank" the way the
  current footer does.

### AlfredClient (`Networking/AlfredClient.swift`)

```swift
struct HealthResponse: Decodable { let ok: Bool; let version: String? }
func health(for baseURL: URL) async throws -> HealthResponse  // GET <base>/api/health
```

Builds the URL against the passed `baseURL` (not the provider) using the same prefix-preserving
splice as `url(_:)`, then runs through the existing `perform`/`decode`. A transport error / non-2xx
surfaces as the usual `AlfredError`, which the view renders as "unreachable."

### SettingsView (`Settings/SettingsView.swift`)

The Form becomes:

- A **Servers** section listing each `Server`: label (or host if unlabelled), URL, a checkmark on
  the active one, tap-to-activate, swipe-to-delete, and a **Test** button showing a spinner →
  ✅ "reachable · vX.Y.Z" (from `health`) or ❌ an error. Editing a server (label + URL) via a
  detail/edit row or an inline add-form.
- An **Add server** affordance (label + URL fields, reusing the validation messaging the current
  footer shows).
- A footer/section showing **app version** (`AppInfo.version`) always, and the active server's
  last-tested version when present.

### Active-server change & the rest of the app

Because `AlfredClient` resolves the base URL per call, switching the active server takes effect on
the next request. The conversation list (`ConversationListViewModel`) and an open `ConversationView`
reload against the active server on their normal `appear`/refresh; this spec does **not** force-pop
to root or invalidate an open conversation on switch (see Open questions).

## Alternatives considered

- **Approach B — saved-URL bookmarks over today's single field.** Keep `baseURLString` as the
  active config and add a separate quick-pick list that copies a URL into the field. Less code
  (store/client untouched) but no first-class "active server": the editable field and the saved
  list can drift, which reads oddly. Rejected — the write-through in Approach A keeps the client
  untouched *and* gives a real selected-server model.
