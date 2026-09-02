# `render_svg` — Architecture Specification

### A self-verifying SVG rendering tool for OpenCode plugins

**Status:** Draft
**Target platform:** OpenCode (`packages/plugin`, `packages/opencode`)
**Author's note:** Every claim about existing OpenCode internals in this document is grounded in the
current OpenCode source tree (paths cited inline). Sections describing the new plugin's own code are
proposed design, not existing code.

---

## 1. Problem statement

Give a model a tool that lets it **draw** — call a tool with SVG markup of its own composition — and get
a trustworthy signal back about whether the drawing is any good, routed through whichever review channel
actually works for that model:

- **Multimodal models** can look at a rendered image directly. The loop should stay entirely in-model:
  render → attach the image to the tool result → let the model critique and re-call the tool itself.
- **Text-only models** cannot look at anything. The loop must hand control to a **human**: render →
  surface it in the terminal/UI the human is actually looking at → block on an explicit approve/reject →
  if rejected, carry the human's free-text comment back to the model as the reason the call failed.

The interesting design problem is not "how do I turn SVG into pixels" — it's **routing the same tool call
through two structurally different feedback loops** using primitives OpenCode already has, rather than
inventing a parallel review mechanism.

---

## 2. What OpenCode already gives us (grounding)

This design is built entirely out of four existing OpenCode mechanisms. Understanding them precisely is
what makes the rest of the document short.

### 2.1 Tool attachments are how images get back to a model

`packages/opencode/src/tool/read.ts` is the existing precedent: when `read` opens an image file, it
doesn't inline the bytes into `output` text — it returns

```ts
{
  title,
  output: "Image read successfully",
  metadata: { ... },
  attachments: [{ type: "file", mime, url: `data:${mime};base64,${...}` }],
}
```

`ToolResult.attachments` (`packages/plugin/src/tool.ts`) is a first-class field of the plugin tool return
type — plugins get this for free, no special casing needed.

Downstream, `packages/opencode/src/session/message-v2.ts` (`toModelOutput`, `supportsMediaInToolResult`)
decides **how** an attachment reaches the model:

- If the active model's API integration is known to accept media inside a tool-result block
  (Anthropic, OpenAI, Bedrock-Mantle, Vertex-Anthropic, and — for images only — Bedrock and xAI, and
  Gemini 3+), the image rides inline in the tool result.
- Otherwise, the media is extracted and re-sent as a **separate synthetic user message** immediately
  after, because "OpenAI-compatible APIs only support string content in tool results" (verbatim comment,
  `message-v2.ts:141-146`).

Either way, **this branching is already handled by core**. The plugin does not need to know the wire
format; it only needs to decide *whether to attach an image at all*, which is a capability question, not
a transport question (see §2.2).

### 2.2 `Model.capabilities.input.image` is the multimodality signal

The SDK's `Model` type (`packages/sdk/js/src/gen/types.gen.ts`) carries:

```ts
capabilities: {
  temperature: boolean
  reasoning: boolean
  attachment: boolean
  toolcall: boolean
  input:  { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }
  output: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }
}
```

This is populated from `models.dev` modality data and provider overrides
(`packages/opencode/src/provider/provider.ts:1291-1302, 1522-1536`). `capabilities.input.image === true`
is the tool's multimodality test.

The complication: **`ToolContext` does not carry the current `Model`.** (`packages/plugin/src/tool.ts` /
`packages/opencode/src/tool/tool.ts::Context` expose `sessionID`, `messageID`, `agent`, `directory`,
`worktree`, `abort`, `metadata()`, `ask()` — no model.) The full `Model` object *is* available on the
`Hooks["chat.params"]` hook, which fires once per LLM request with
`{ sessionID, agent, model, provider, message }`. The plugin therefore needs a small bridge: cache
`sessionID → Model` on `chat.params`, read it back inside the tool's `execute()`. Full design in §4.2.

### 2.3 `ctx.ask()` is the human approve/reject primitive, and rejection already carries free text

`ToolContext.ask(input)` (`packages/plugin/src/tool.ts`) is not a bespoke plugin API — it is bridged
1:1 (`packages/opencode/src/tool/registry.ts:143-153`, `bridge.promise(toolCtx.ask(req))`) onto the core
`Permission.Service.ask` Effect (`packages/opencode/src/permission/index.ts`), the same machinery every
built-in tool (`bash`, `edit`, `write`, `read`, …) uses to pause on a permission dialog.

The reply path (`packages/opencode/src/permission/index.ts::reply`, schema at
`packages/schema/src/v1/permission.ts::ReplyBody`) is:

```ts
ReplyBody = { reply: "once" | "always" | "reject", message?: string }
```

A `reject` reply with a `message` produces:

```ts
// packages/core/src/v1/permission.ts
class CorrectedError {
  feedback: string
  get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}
```

This `Error` is what `ctx.ask()`'s returned promise rejects with. The plugin's `execute()` never has to
build its own "send comments back to the model" channel — **it just lets the rejection propagate**.
`packages/opencode/src/session/processor.ts::failToolCall` writes `error: errorMessage(error)` into the
tool-call part, and that error string is exactly what the model reads on its next turn. Approve/disapprove
*with comments* is therefore a stock feature of every OpenCode tool, not something `render_svg` invents.

This is also, critically, **client-agnostic**: whichever surface is attached to the session — the actual
terminal TUI (`packages/tui`), the web app, or the desktop app — renders the pending `PermissionRequest`
and collects the reply the same way. The plugin doesn't render a dialog; it asks a question and the
attached client renders it appropriately. "Presents the output in the terminal" in practice means: the
plugin makes sure something inspectable is available where a terminal-only user *can* look (see §4.5),
then calls `ctx.ask()` so that same user is the one unblocking it.

### 2.4 Nothing in core rasterizes SVG, and no terminal client in this codebase draws inline images

`packages/opencode/src/image/image.ts` (Photon/WASM, used to auto-resize outbound attachments) decodes
**raster** formats only — there is no SVG parser in the pipeline. `render_svg` must bring its own
rasterizer as a dependency (§4.3).

Searching `packages/tui` for any terminal graphics protocol (kitty, sixel, iTerm inline images) or an
`attachment`/`mime`-aware image renderer turns up nothing — the terminal client renders text/markdown
only. Only the web/desktop client (`packages/session-ui/src/components/message-part.tsx`, via
`<img src={file.url}>`) paints attachment images. That means for the terminal-attached, non-multimodal
case, "present the output" cannot mean "draw pixels in the TTY" — it has to mean: **write the render to a
file, open it in the user's default viewer** (the codebase already depends on the `open` npm package for
exactly this pattern — `packages/opencode/src/cli/cmd/web.ts`, `packages/opencode/src/mcp/browser.ts`
both call `open(url)` to hand off to the OS), and give the terminal transcript a readable textual summary
of what was rendered so the permission prompt has context even before the viewer window appears.

---

## 3. High-level flow

```
Model calls render_svg(svg, title?, viewport?)
        │
        ▼
┌───────────────────────────────────────────────┐
│ 1. Validate & sanitize SVG (§4.1)              │
│    - well-formed XML, root <svg>, size caps    │
│    - strip <script>, on*=, external refs       │
└───────────────────────────────────────────────┘
        │ ok
        ▼
┌───────────────────────────────────────────────┐
│ 2. Rasterize SVG → PNG (§4.3)                  │
│    resvg-wasm, deterministic, sandboxed        │
└───────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────┐
│ 3. Resolve current model capabilities (§4.2)   │
│    session cache populated by chat.params hook │
└───────────────────────────────────────────────┘
        │
   ┌────┴─────────────────────┐
   │ image input supported?   │
   └────┬─────────────────┬───┘
      yes│                 │no
        ▼                 ▼
┌────────────────┐   ┌─────────────────────────────────┐
│ PATH A          │   │ PATH B                          │
│ Multimodal      │   │ Non-multimodal → human review   │
│ (§5)            │   │ (§6)                             │
│                 │   │                                  │
│ Attach PNG to   │   │ Write .svg + .png to workspace   │
│ ToolResult.     │   │ render cache; open in OS viewer; │
│ attachments.    │   │ ctx.ask() blocks for a verdict.  │
│ Model "sees"    │   │                                  │
│ its own render  │   │  approve ──► ok, output = brief  │
│ next turn and   │   │              structural summary  │
│ can iterate.    │   │  reject  ──► CorrectedError w/    │
│                 │   │              feedback text auto- │
│                 │   │              propagates to model │
└────────────────┘   └─────────────────────────────────┘
```

---

## 4. Shared components

### 4.1 Input contract

```ts
tool({
  description: DESCRIPTION, // loaded from render_svg.txt, per house convention (see read.txt, write.txt)
  args: {
    svg: tool.schema.string().describe(
      "Complete, self-contained SVG markup (must start with <svg ...> and be well-formed XML). " +
      "Do not reference external files, fonts, or URLs."
    ),
    title: tool.schema.string().optional().describe("Short human-readable title for this render."),
    width: tool.schema.number().int().positive().max(4096).optional()
      .describe("Rasterization width in px. Defaults to the SVG's intrinsic width or 1024."),
    height: tool.schema.number().int().positive().max(4096).optional(),
    background: tool.schema.enum(["transparent", "white"]).optional().default("white"),
  },
  execute(args, ctx) { ... },
})
```

Keeping the argument surface small (raw SVG text, not a DSL) matches the request: the model composes the
SVG "of its own choice," the tool's job is purely render + route-for-review.

### 4.2 Model-capability cache (bridges `chat.params` → tool `execute`)

Because `ToolContext` has no `Model`, register both hooks from the same plugin module and share state
through a module-level map keyed by `sessionID`:

```ts
const modelBySession = new Map<string, Model>()

export const RenderSvgPlugin: Plugin = async () => ({
  "chat.params": async (input) => {
    modelBySession.set(input.sessionID, input.model)
  },
  tool: {
    render_svg: tool({ /* ... */
      async execute(args, ctx) {
        const model = modelBySession.get(ctx.sessionID)
        const isMultimodal = model?.capabilities.input.image === true
        // ...
      },
    }),
  },
})
```

Notes:
- `chat.params` fires before each LLM request, so the cache reflects the model *about to receive* the
  tool result — correct even if the user switches models mid-session.
- Fall back to "treat as non-multimodal" if the cache is empty (e.g. tool called before any
  `chat.params` firing is observed, or a provider integration that doesn't populate capabilities) — the
  human-review path is always safe to take; silently mis-attaching an image to a model that can't read it
  is not.
- This is a plugin-level in-memory cache, not persisted — acceptable, since it only needs to survive the
  lifetime of one running OpenCode instance/session, matching how `InstanceState` is used elsewhere in
  core for comparable per-session caches.

### 4.3 SVG validation & rasterization

**Validation** (defense before any rendering happens):
- Parse as XML; reject on parse failure with a precise error (`InvalidArgumentsError`-style message so the
  model can self-correct, per the existing convention in `packages/opencode/src/tool/tool.ts`).
- Reject/strip: `<script>`, `on*` event attributes, `<foreignObject>` containing HTML, external
  `href`/`xlink:href`/`url()` references (fonts, images, stylesheets) that would cause the renderer to
  make network calls. SVG is executable content in a browser context; since Path A's output can be
  re-displayed in a web/desktop client, and Path B's output is opened directly in a system viewer/browser,
  treat untrusted-model-generated SVG with the same suspicion as untrusted-user HTML.
- Cap document size (e.g. 256 KB of markup) and rasterized pixel area (width × height ≤ ~4M px) to bound
  memory and avoid decompression-bomb-style patterns (deeply nested `<use>`/`<pattern>` recursion).

**Rasterization**: no in-repo SVG renderer exists (§2.4), so the plugin depends on a WASM/native SVG
rasterizer such as `@resvg/resvg-js` (or `@resvg/resvg-wasm` for platforms where native bindings are
undesirable) to render deterministically, without a browser, to PNG bytes. Output should be encoded as a
`data:image/png;base64,...` URL — the exact shape `ToolResult.attachments[].url` and the web client's
`<img src>` both already expect (§2.1, §2.3).

Recommended defaults: white or transparent background (configurable via `background` arg, since SVGs with
transparent backgrounds are hard for a human *or* a model to judge on a dark terminal-adjacent viewer),
2× device-scale factor for legibility, PNG (not JPEG — SVG output is typically line art/UI mockups where
JPEG artifacting actively harms review quality).

### 4.4 Render cache path

Write both the original SVG and the rasterized PNG to a stable, session-scoped location under the
project's `worktree`, following the pattern of other generated-artifact caches in the repo
(`.opencode/` is already the convention for tool-local state — see the top-level `.opencode/` directory in
the project itself):

```
{worktree}/.opencode/render-svg/{sessionID}/{callID}.svg
{worktree}/.opencode/render-svg/{sessionID}/{callID}.png
```

This path is useful in both branches: Path A can reference it in `metadata` for debugging/audit even
though the model gets the image inline; Path B needs it to open a real file in a real viewer.

---

## 5. Path A — multimodal model

```ts
if (isMultimodal) {
  return {
    title: args.title ?? "Rendered SVG",
    output: `Rendered a ${png.width}x${png.height} PNG from the provided SVG. Review the attached image ` +
            `and continue iterating if anything looks wrong.`,
    metadata: { svgBytes: args.svg.length, width: png.width, height: png.height, cachePath },
    attachments: [
      { type: "file", mime: "image/png", url: `data:image/png;base64,${png.base64}` },
    ],
  }
}
```

That's the entire multimodal path. There is deliberately **no additional gating** here: since the model
can see the render, the review loop is "call `render_svg`, look at the result, call it again if unhappy" —
exactly how `read` already lets a multimodal model look at any image file. `message-v2.ts`'s
`supportsMediaInToolResult`/extraction logic (§2.1) transparently handles whether the PNG rides inline in
the tool result or as a follow-up synthetic user message; the plugin does not special-case providers.

**Design choice, stated explicitly:** this document does *not* additionally block Path A on `ctx.ask()`.
The prompt describes multimodal review as self-contained ("presents the result back to the model itself");
adding a human permission gate here would silently convert every multimodal call into the same flow as
Path B and defeat the point of the branch. If a deployment wants human-in-the-loop even for multimodal
models (e.g. "approve every render before it counts as done"), that is a configuration flag on top of this
design (§8), not the default.

---

## 6. Path B — non-multimodal model, human review

```ts
if (!isMultimodal) {
  await fs.writeFile(cachePath.svg, args.svg)
  await fs.writeFile(cachePath.png, png.bytes)
  await open(cachePath.png).catch(() => {})   // best-effort; never block on opener failure

  const summary = summarizeSvg(args.svg)      // "3 <rect>, 2 <path>, viewBox 0 0 800 600, ..."

  try {
    await ctx.ask({
      permission: "render_svg",
      patterns: [cachePath.png],
      always: ["*"],
      metadata: {
        title: args.title ?? "SVG render awaiting review",
        cachePath: cachePath.png,
        summary,
        preview: `data:image/png;base64,${png.base64}`, // clients that *can* render an image
                                                          // (web/desktop) show it in the permission
                                                          // dialog even though the model can't see it
      },
    })
  } catch (err) {
    // PermissionV1.RejectedError or PermissionV1.CorrectedError — rethrow as-is.
    // The framework turns err.message into the tool's error output for the model automatically
    // (session/processor.ts::failToolCall). No manual formatting needed.
    throw err
  }

  return {
    title: args.title ?? "Rendered SVG (approved)",
    output: `Render approved by user. Saved to ${cachePath.svg}. ${summary}`,
    metadata: { cachePath: cachePath.svg, width: png.width, height: png.height },
    // No image attachment: the model cannot consume it, and attaching it anyway would
    // (a) waste context/tokens and (b) rely on the model silently ignoring media it can't read.
  }
}
```

Why this satisfies "presents the output in the terminal": the terminal user gets three complementary
signals, layered because a bare TTY cannot paint pixels (§2.4):

1. **Immediate textual summary** in the tool-call transcript line (element counts, viewBox, size) — always
   visible, zero extra action.
2. **An opened viewer window** with the actual rendered PNG — the real "look at it" step, delegated to
   whatever the OS already uses for image files (mirrors the existing `open(url)` pattern used for the web
   UI and MCP browser flows).
3. **The permission prompt itself**, rendered by whichever client is attached to the session. In the
   terminal TUI this is a text prompt (approve / always / reject, with a free-text reason on reject,
   per `ReplyBody` in §2.3); in the web/desktop client the same `PermissionRequest.metadata.preview` field
   lets that client additionally show the image inline in the dialog, since `session-ui` already knows how
   to render a `data:image/...` URL (§2.1) — no separate code path required, just population of the field.

Rejection feedback requires **no bespoke plumbing**: `ctx.ask()` throwing a `CorrectedError` is the same
mechanism `bash`, `edit`, and every other permission-gated tool already relies on, and its `.message`
("...with the following feedback: {feedback}") is what lands in the tool-call's `error` field and is what
the model reads next turn (§2.3). The model gets the human's actual words, verbatim, as the reason the
call didn't succeed — the model can then adjust the SVG and call `render_svg` again.

---

## 7. Error surfaces (both paths)

| Failure | Mechanism | Model-visible message |
|---|---|---|
| Malformed SVG / disallowed content | Thrown before rasterization | Precise validation error, tool re-callable |
| Rasterizer crash/timeout | Caught, wrapped | Generic "render failed" + reason, no partial attachment |
| User rejects (Path B), no reason given | `PermissionV1.RejectedError` | "The user rejected permission to use this specific tool call." |
| User rejects (Path B) with comments | `PermissionV1.CorrectedError` | "...with the following feedback: {verbatim text}" |
| `open()` fails to launch a viewer | Swallowed (`.catch(() => {})`) | Not surfaced — `ctx.ask()` still proceeds; cache path is in the prompt metadata as a manual fallback |
| Model capability cache empty | Defaults to Path B | No error — safe default, see §4.2 |

---

## 8. Configuration surface (plugin options)

Exposed via the standard `PluginOptions` mechanism (`Plugin = (input, options?) => Promise<Hooks>`,
configured in `opencode.json` as `plugin: [["render-svg", { ...options }]]`):

```ts
type RenderSvgOptions = {
  maxSvgBytes?: number              // default 256_000
  maxPixels?: number                // default 4_000_000 (e.g. 2000x2000)
  defaultBackground?: "white" | "transparent"
  autoOpenViewer?: boolean          // default true; set false in headless/CI environments
  forceHumanReview?: boolean        // default false; if true, always take Path B regardless of
                                     // model capabilities — for teams that want a human gate on
                                     // every generated visual, multimodal model or not
  cacheDir?: string                 // default "{worktree}/.opencode/render-svg"
}
```

---

## 9. Security notes

- SVG is treated as untrusted, model-generated, potentially-executable content. Sanitization (§4.3) is
  mandatory, not optional, because the render is opened in a real OS-level viewer/browser (Path B) and
  may be re-displayed in the web/desktop client's DOM (Path A, §2.1's `<img>` rendering path is safe for
  raster PNG bytes, but any code path that ever fell back to embedding raw SVG markup instead of a
  rasterized PNG would reintroduce script/XSS risk — this design intentionally never sends raw SVG to a
  client, only the rasterized PNG).
- The rasterizer must not fetch network resources referenced from the SVG (fonts, images, `<image href>`)
  — either run it with network access disabled, or strip such references during validation, or both
  (defense in depth).
- `ctx.ask()`'s existing pattern-matching permission rules (`always: ["*"]`, evaluated against configured
  rulesets in `packages/opencode/src/permission/index.ts::evaluate`) mean a user (or org config) can
  pre-approve `render_svg` globally the same way they would `read` — this is existing, auditable behavior,
  not something this plugin needs to reimplement.

---

## 10. Summary of what is genuinely new vs. reused

| Concern | Reused from OpenCode core | New in this plugin |
|---|---|---|
| Getting an image to a multimodal model | `ToolResult.attachments`, `message-v2.ts` transport logic | Deciding *when* to attach |
| Detecting multimodality | `Model.capabilities.input.image` | Session-scoped cache via `chat.params` (no existing bridge) |
| Human approve/reject UI | `ctx.ask()` → `Permission.Service`, rendered by attached client | Populating `metadata.preview`/`summary` usefully |
| Carrying rejection comments to the model | `PermissionV1.CorrectedError.message` → tool error | None — used as-is |
| SVG → pixels | — (nothing exists in core) | Full rasterization + validation pipeline |
| "Show it in the terminal" | `open()` pattern (`cli/cmd/web.ts`, `mcp/browser.ts`) | Render-cache file layout, textual summary generator |
