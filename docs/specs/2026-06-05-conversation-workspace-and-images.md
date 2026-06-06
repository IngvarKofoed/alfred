# Conversation workspaces & image support

Give every conversation its own working directory on disk
(`data/conversations/<conversation_id>/`) and use it as the foundation for
file-bearing capabilities. On top of that foundation this increment ships three
things: **image input (vision)** — the agent can see browser screenshots and
user-uploaded images; **image generation** — a `generate_image` tool; and a
**minimal file-tool trio** (`read_file` / `write_file` / `list_files`). Code
execution / scripting reuses the same workspace later and is out of scope here.

The load-bearing move (Approach A, chosen): files live on disk, referenced by a
workspace-relative path; Postgres stays blob-free; the **worker bridges** the
on-disk reference ↔ the inline-base64 form the model needs.

## Key decisions

- **Per-conversation workspace dir** (diverges). Files live in
  `data/conversations/<conversation_id>/`, not the flat `data/attachments/`
  keyed-by-path of ARCHITECTURE §6.5. A conversation's files are a movable,
  deletable unit, and it's the natural home for later scripting. §6.5 will be
  updated to match.
- **Path confinement** (new). Every file path is resolved through one
  `resolveInWorkspace(conversationId, relPath)` helper that rejects absolute
  paths, `..` escapes, and symlink-outs. All file ops (tools, upload, serving)
  go through it. Cheap now, essential once `write_file`/scripting exist. Scoping
  to a single conversation is deliberate but not permanent — confinement is
  centralized in this one helper precisely so a future "shared" scope (several
  conversations over the same working set, e.g. a shared codebase) is a change
  to *what root a path resolves against*, not a rewrite of every call site.
- **Two image representations, worker bridges** (new). DB/wire form is a
  reference `{ type:'image', path, mimeType }`; agent-core form is inline
  `{ type:'image', mimeType, data }` (base64). The worker reads files → inlines
  base64 when assembling history, and writes base64 → files + reference when
  persisting. Postgres and NOTIFY never carry image bytes.
- **`image` ContentPart** (extends). Add one variant to the agent-core
  `ContentPart` union (`packages/agent-core/src/types.ts:1`). The loop already
  passes parts through untouched.
- **Gemini `inlineData`** (extends). `toGeminiContents`
  (`providers/gemini.ts:83`) gains one case: an `image` part →
  `{ inlineData: { mimeType, data } }`. This single change serves *both*
  uploads and tool-produced images.
- **Image-bearing tool results** (extends). A tool signals an image result via a
  small `ImageToolResult` type + `isImageResult` guard **exported from
  agent-core** (one source of truth the loop and worker both import). The loop
  turns it into a short text ack (the Gemini `functionResponse`, which can't
  carry an image) **plus** an `image` part on the same tool turn, so the model
  actually sees the screenshot/generated image. Image results bypass the
  100k-char cap (`browser/tools.ts:4`) and are never stored as base64 in
  `tool_calls.result` — that row stores the reference.
- **Upload endpoint** (new). `POST /api/conversations/:id/files` (multipart,
  one file) saves into the workspace and returns the relative path. The existing
  JSON `POST /messages` gains an optional `attachments: [{ path, mimeType }]`.
- **Media serving** (reuses). `GET /media/:conversationId/:filename` reads from
  the workspace via the same `serveStatic`-style mechanism already used for the
  SPA (`webserver/src/index.ts:12`), through `resolveInWorkspace`.
- **`generate_image` built-in tool** (new). Per-run built-in (the
  `makeSetTitleTool` pattern, `catalog.ts:14`) calling `gemini-2.5-flash-image`
  via `@google/genai`; returns an image result the worker persists + renders.
  Needs a new `pricing.ts` entry (per-image rate, confirmed at build).
- **File tools, workspace-confined** (new). `list_files` and `read_file` are
  `read`-tier, `write_file` is `write`-tier (approval-gated). Per-run built with
  the conversation id; all paths through `resolveInWorkspace`. `read_file` is
  image-aware: an image file is returned as an `ImageToolResult` (reusing the
  same loop path, so the model sees it); other files return text. `write_file`
  is text-only this increment.

## Goals

- The agent can see images: browser screenshots it takes, and images the owner
  uploads into the chat.
- The agent can generate an image from a prompt; it renders in chat and the
  agent can see it (so "now make it bluer" works).
- The owner can upload an image from the web chat.
- A minimal, safe per-conversation file surface (`read`/`write`/`list`), built
  so richer filesystem support slots in later.
- Postgres stays blob-free; history reads stay cheap.

## Non-goals

- Code execution / running scripts (Python, shell). The workspace is built for
  it; the tools are not in this increment.
- Rich filesystem ops (move, delete, mkdir, glob), binary `write_file`,
  cross-conversation file sharing, an `attachments` DB table.
- Streaming image bytes over NOTIFY/SSE (the 8000-byte cap forbids it; the
  client fetches `/media/...` after the run, on the existing history reload).
- PDF/audio attachments, multi-file upload in one request, drag-and-drop polish.
- Vision on any model other than Gemini.

## Design

### Workspace foundation

A new `WORKSPACE_ROOT` config (default `./data/conversations`, added to
`packages/shared/src/config.ts`). The directory for a conversation is created
lazily on first write. `resolveInWorkspace(conversationId, relPath)` lives in a
new shared module (worker + webserver both use it); it joins, normalizes, and
asserts the result stays under `<root>/<conversationId>/`, throwing otherwise.

### agent-core changes

```ts
// types.ts — one new ContentPart variant (inline base64; agent-core is storage-agnostic)
| { type: 'image'; mimeType: string; data: string }
```

`toGeminiContents` renders an `image` part as `{ inlineData: { mimeType, data } }`
in both `user` and `tool` turns.

A tool returns an image via a small marker, e.g.
`{ image: { mimeType, data }, summary?: string }`. The loop detects it (a
`isImageResult` guard), and for that tool builds: a `tool_result` part whose
`result` is `{ summary }` (the text ack Gemini gets in `functionResponse`) and
an `image` part on the same `role:'tool'` message. Net agent-core surface: one
new union variant, one provider case, one image-aware branch in the loop's
tool-result assembly. Approval/streaming/error paths are untouched.

### Worker: the bridge

- **Loading history** (`run.ts:44`, `messages.ts`): when converting rows to
  agent-core messages, each `{ type:'image', path, mimeType }` reference is read
  off disk and turned into `{ type:'image', mimeType, data }` (base64). Missing
  file → a text part noting the image is unavailable (fail loud, don't crash).
- **Persisting image tool results** (`onToolEnd`, `run.ts:148`): when a tool
  outcome carries an image, write the bytes to the workspace
  (`<tool>-<ts>.<ext>`), store the **reference** in `tool_calls.result`, and
  append the reference to the assistant/tool message content that gets persisted.
  The in-memory base64 still flows to the model this turn (no disk round-trip
  mid-run); disk is for persistence, the UI, and next-run replay.
- **Uploaded images**: already on disk (written by the upload endpoint). The
  user message row stores the reference; the worker inlines base64 on load like
  any other image.

### Vision input — screenshots

The extension already implements `screenshot` and `screenshot_element`
(`chrome-extension/src/background.ts:352`), returning `{ data: <base64>,
mimeType: 'image/png' }`. Expose them as two new entries in `browser/tools.ts`
`SPECS`, but routed so their result is the image marker (above) and **bypasses**
`capResult`. They stay in the process-static browser toolset (group `browser`,
`write` tier) — the worker, which knows the conversation id, owns persistence.

### Vision input — upload

- `POST /api/conversations/:id/files`: parse multipart via Hono's
  `c.req.parseBody()` (no new dep), validate the type is `image/png`, `jpeg`,
  `webp`, or `gif` and the size is ≤10 MB, write through `resolveInWorkspace`,
  return `{ path, mimeType }`. Other types/oversize are rejected at the endpoint.
- Client (`Chat.tsx`): a file-picker button next to the input; on pick, upload
  immediately, show a thumbnail "pending attachment". On send, include
  `attachments` in the existing JSON POST and render the image optimistically.
- `POST /messages` (`app.ts:29`): accept optional `attachments`, building the
  user message content as `[{type:'text',text}, {type:'image',path,mimeType}…]`.

### Image generation

`generate_image(prompt: string)` — a `write`-tier built-in (so it pauses for
approval by default; owner can disable on the Tools page). It calls a Gemini
image model (`gemini-2.5-flash-image`) via `@google/genai`, returns the image
marker; the worker persists + the client renders it. The model also sees it
(image-feedback path), enabling iterative edits. Pricing: a new `MODEL_PRICING`
entry (per-image rate, confirmed at build — add a per-image dimension to
`computeCostUsd` if the existing per-token shape doesn't fit).

### File tools

`list_files`, `read_file`, `write_file` — per-run built-ins (`catalog.ts:14`)
carrying the conversation id, every path resolved through `resolveInWorkspace`.
`read_file` is image-aware: for an image file it returns an `ImageToolResult`
(the same path screenshots/generation use, so the model sees it); otherwise text.
`write_file` writes text only this increment. This is the minimal surface; richer
ops (move/delete/mkdir/glob, binary write) and code execution come later on the
same workspace.

### Client rendering

`Bubble` (`Chat.tsx:277`) maps `image` parts to `<img src="/media/<convId>/<path>">`
(with a max size), for user, assistant, and tool-result turns. `textOf` ignores
image parts as today; tool-result image turns now render (a thumbnail), unlike
the empty-bubble suppression for text-only tool results (changelog 33). No new
NOTIFY event — generated/screenshot images appear on the existing `done` →
`loadHistory` refresh.

## Alternatives considered

- **base64 inline in the DB jsonb** (rejected). Simpler — no disk, no serving
  route, no worker bridge. But violates §6.5, bloats every history read with
  megabytes of base64, and images still can't stream over the 8000-byte NOTIFY
  cap. The disk+reference cost buys cheap history reads and a real workspace.
- **Flat `data/attachments/` keyed by id** (the original §6.5 shape, rejected in
  favor of the workspace). A global pool doesn't give us the per-conversation
  working directory the owner wants for scripting, and makes "wipe this
  conversation's files" a query instead of an `rm -rf` of one dir.
- **Main model emits images directly** (rejected for generation). Would force an
  image-output-capable chat model and complicate the loop. A `generate_image`
  tool keeps the chat model swappable and image-gen as just another tool.
