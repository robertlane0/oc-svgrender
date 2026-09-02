# `render_svg` — Implementation Plan

> Source of truth for behavior: [`PLUGIN.md`](./PLUGIN.md) (architecture spec, grounded in OpenCode `dev` at paths cited inline). This document is the **step-by-step build plan** — what to create, in what order, and how to verify each step. Keep it in sync with `PLUGIN.md`; if they conflict, `PLUGIN.md:1` is canonical for product decisions.

## 0. How to use this plan

- Work top-down: phases are dependency-ordered. Do not start Phase 5 (dual-path routing) before Phase 2–4 pass verification.
- After each phase, run the **Verification** command listed for that phase.
- File paths below are given as `opencode/<path>` (the git-tracked OpenCode checkout, symlinked at `opencode -> /tmp/code/opencode`) and as repo-root paths for net-new code. Line-number citations are pinned to the `opencode` checkout at time of writing; re-grep if they drift.
- Follow `opencode/AGENTS.md:1` for style, commits, branch names, and `Effect` conventions unless this plan explicitly overrides.

---

## 1. Context and goals

### 1.1 What you are building

A single OpenCode plugin tool `render_svg` that:

1. Accepts raw `svg` markup authored by the model (plus optional `title`, `width`, `height`, `background`).
2. Validates / sanitizes, rasterizes to PNG, and then **routes** the result through one of two existing OpenCode review loops:
   - **Path A (multimodal):** attach PNG to `ToolResult.attachments` so the calling model sees its own render next turn (`opencode/packages/opencode/src/tool/read.ts:1`, `opencode/packages/opencode/src/session/message-v2.ts:147`).
   - **Path B (text-only / human):** persist files, `open()` in OS viewer, block on `ctx.ask()` with human approve/reject, and propagate `CorrectedError.feedback` back to the model (`opencode/packages/plugin/src/tool.ts:1`, `opencode/packages/opencode/src/permission/index.ts:1`, `opencode/packages/core/src/v1/permission.ts:1`).

The novel code is only the validation + rasterization + routing glue (see `PLUGIN.md:444`). Everything else is reuse.

### 1.2 Non-goals

- No new terminal graphics protocol (kitty/sixel). The TUI is text-only (`PLUGIN.md:137`).
- No new permission UI. `ctx.ask()` renders in whichever client is attached (`PLUGIN.md:125`).
- No SVG DSL — input is raw markup (`PLUGIN.md:202`).

### 1.3 Decision: where does the plugin live?

Two viable repo shapes; pick one early and stick to it:

| Option | Layout | When to choose |
|---|---|---|
| **A — standalone package** (recommended) | `./package.json` at `oc-svgrender/` root, `./src/render_svg.ts`, `./src/render_svg.txt`, publishes as `opencode-plugin-render-svg` | You want the plugin installable via `opencode.json: plugin: [["render-svg", {...}]]` without touching the `opencode` checkout. Keeps the `opencode` symlink read-only. |
| **B — in-tree** | `opencode/packages/opencode/src/tool/render_svg.ts` + `render_svg.txt` alongside `read.ts`, `write.ts` | You are upstreaming into OpenCode core rather than shipping a plugin. Requires edits inside the `opencode` checkout. |

This plan assumes **Option A** and notes deltas for Option B where they matter. If you take Option B, skip §3.1 scaffolding and use the existing `Tool.define` path (`opencode/packages/opencode/src/tool/tool.ts:1`) instead of `@opencode-ai/plugin/tool.ts:1`.

---

## 2. Ground truth checklist (validate before coding)

Re-verify the four load-bearing claims in `PLUGIN.md:32`. If any have drifted, stop and revise `PLUGIN.md` first.

- [ ] `ToolResult.attachments` exists and is threaded through `opencode/packages/opencode/src/tool/registry.ts:143-153` via `bridge.promise(toolCtx.ask(req))` and `opencode/packages/opencode/src/session/message-v2.ts:147-311` branching on `supportsMediaInToolResult`.
  - `grep -rn "supportsMediaInToolResult\|attachments" opencode/packages/opencode/src/session/message-v2.ts`
- [ ] `Model.capabilities.input.image` shape matches `opencode/packages/sdk/js/src/gen/types.gen.ts` / `models.dev` mapping in `opencode/packages/opencode/src/provider/provider.ts:1291-1302,1522-1536`.
  - `grep -n "capabilities" opencode/packages/sdk/js/src/gen/types.gen.ts | head`
- [ ] `ToolContext` **does not** carry `Model` (`opencode/packages/plugin/src/tool.ts:1`, `opencode/packages/opencode/src/tool/tool.ts:1`) — only `sessionID`, `messageID`, `agent`, `directory`, `worktree`, `abort`, `metadata()`, `ask()`.
  - `cat opencode/packages/plugin/src/tool.ts`
- [ ] `Permission.Service.ask` → `ReplyBody { reply: "once"|"always"|"reject", message?: string }` → `PermissionV1.CorrectedError/RejectedError` (`opencode/packages/core/src/v1/permission.ts:1`, `opencode/packages/opencode/src/permission/index.ts:1`) and `opencode` already depends on `open` (`opencode/packages/opencode/src/cli/cmd/web.ts:6`, `opencode/packages/opencode/src/mcp/browser.ts:1`).
  - `grep -rn "CorrectedError\|RejectedError" opencode/packages/core/src/v1/permission.ts`
  - `grep -rn "\"open\"\|from \"open\"" opencode/packages/opencode/src --include="*.ts" | head`

**Verification:** all greps return matches; no file-not-found errors. If `open` is not in `package.json` of the chosen package, add it in Phase 3.

---

## 3. Phase 1 — Project bootstrap

### 3.1 Scaffold (Option A)

```
oc-svgrender/
├── AGENTS.md                 # this file
├── PLUGIN.md                 # spec (existing)
├── LICENSE
├── package.json              # plugin package
├── tsconfig.json
├── bun.lock                  # or package-lock
├── src/
│   ├── index.ts              # Plugin export (RenderSvgPlugin)
│   ├── render_svg.ts         # tool definition + execute (or split)
│   ├── render_svg.txt        # tool description (house convention, cf. read.txt/write.txt)
│   ├── validate.ts           # SVG validation & sanitization
│   ├── rasterize.ts          # resvg wrapper
│   ├── cache.ts              # render-cache paths + I/O
│   ├── summarize.ts          # textual summary generator (Path B)
│   └── config.ts             # RenderSvgOptions + defaults
└── test/
    ├── validate.test.ts
    ├── rasterize.test.ts
    ├── render_svg.test.ts    # Path A/B routing with mocked ctx.ask
    └── fixtures/             # sample SVGs (valid, script-injected, external-ref, bomb)
```

**Tasks:**
1. `bun init` (or `npm init`) at `oc-svgrender/` — **do not** run inside `opencode/`. The `opencode` symlink must stay a plain symlink; `oc-svgrender/.gitignore:1` ignores the built `opencode` dir at deploy time but the symlink is tracked in this repo.
2. `package.json`:
   ```json
   {
     "name": "opencode-plugin-render-svg",
     "version": "0.1.0",
     "type": "module",
     "exports": { ".": "./src/index.ts" },
     "dependencies": {
       "@opencode-ai/plugin": "workspace:* or ^1.18.26",
       "@resvg/resvg-wasm": "^2.6.2",
       "open": "^10.1.0"
     },
     "devDependencies": {
       "typescript": "^5.8.2",
       "bun-types": "^1.3.13",
       "@types/bun": "^1.3.13"
     }
   }
   ```
   - Prefer `@resvg/resvg-wasm` over `@resvg/resvg-js` (WASM = no native build, works in all CI/OS per `PLUGIN.md:271`). Pin a single choice; do not depend on both.
   - If targeting Option B (in-tree), add deps to `opencode/packages/opencode/package.json` and note in `opencode/bun.lock` via `bun install`.
3. `tsconfig.json` — extend `opencode/tsconfig.json` or `opencode/packages/plugin/tsconfig.json` for consistency. Enable `strict`, `verbatimModuleSyntax`, `erasableSyntaxOnly` if upstream does (check `opencode/tsconfig.json`).
4. Create `src/render_svg.txt` — one-paragraph tool description loaded as `DESCRIPTION` (matches `opencode/packages/opencode/src/tool/read.txt:1` convention). Draft:
   > Renders the provided SVG markup to a PNG and routes it for review. For image-capable models the PNG is attached to the tool result for self-critique; for text-only models the render is saved to the workspace cache, opened in the OS viewer, and gated on human approve/reject (rejection feedback is returned as the tool error).
5. Create `.opencode/render-svg/.gitkeep` if you want the cache root visible early (gitignored in production; path is `{worktree}/.opencode/render-svg/{sessionID}/` per `PLUGIN.md:284`).

### 3.2 Plugin entry contract

- Export `RenderSvgPlugin` satisfying `Plugin` from `@opencode-ai/plugin` (`opencode/packages/plugin/src/index.ts:74-76`):
  ```ts
  import type { Plugin } from "@opencode-ai/plugin"
  export const RenderSvgPlugin: Plugin = async (input, options) => ({
    "chat.params": /* §4.2 */,
    tool: { render_svg: /* §4 + §5/6 */ }
  })
  ```
- Also provide `export default RenderSvgPlugin` for `opencode.json` string-form loading (`plugin: ["render-svg"]`).
- Keep all module-level state in the closure or a file-scoped `Map` deliberately shared between `chat.params` and `tool.execute` (§4.2) — not in `PluginInput` globals.

### 3.3 Verification (Phase 1)

```bash
bun tsc --noEmit          # or bun typecheck
bun run build  # if you add a build step
ls src/render_svg.txt
grep -q "render_svg" src/index.ts
```

Criteria: package installs, `tsc` passes with no errors, `src/render_svg.txt` exists.

---

## 4. Phase 2 — Shared components (do before routing)

Implement in dependency order: `config.ts` → `validate.ts` → `rasterize.ts` → `cache.ts` / `summarize.ts`.

### 4.1 Input contract & config (`src/config.ts`)

Reproduce `PLUGIN.md:198-218` and `PLUGIN.md:407-422`:

```ts
// args schema (Zod, via tool.schema)
export const RenderSvgArgs = {
  svg: tool.schema.string().describe("Complete, self-contained SVG markup ..."),
  title: tool.schema.string().optional().describe("Short human-readable title ..."),
  width: tool.schema.number().int().positive().max(4096).optional(),
  height: tool.schema.number().int().positive().max(4096).optional(),
  background: tool.schema.enum(["transparent", "white"]).optional().default("white"),
}

// plugin options
export type RenderSvgOptions = {
  maxSvgBytes?: number        // default 256_000
  maxPixels?: number          // default 4_000_000
  defaultBackground?: "white" | "transparent"
  autoOpenViewer?: boolean    // default true
  forceHumanReview?: boolean  // default false (§8)
  cacheDir?: string           // default "{worktree}/.opencode/render-svg"
}
export const DEFAULTS = { maxSvgBytes: 256_000, maxPixels: 4_000_000, defaultBackground: "white", autoOpenViewer: true, forceHumanReview: false } as const
```

- Merge `options` from `Plugin(input, options)` with `DEFAULTS` once at plugin init; pass resolved options into `execute` via closure (do not re-read per call).
- Document each option in `README.md` (if you add one) and in code comments.

### 4.2 Model-capability cache (`src/index.ts` — shared state)

Reproduce `PLUGIN.md:222-256`:

```ts
import type { Model } from "@opencode-ai/sdk"
const modelBySession = new Map<string, Model>()
```

- Hook:
  ```ts
  "chat.params": async (input) => { modelBySession.set(input.sessionID, input.model) }
  ```
- Inside `execute`, read:
  ```ts
  const model = modelBySession.get(ctx.sessionID)
  const isMultimodal = model?.capabilities.input.image === true
  ```
- **Fallback:** `undefined` or `false` → treat as non-multimodal (Path B). This is the safe default (`PLUGIN.md:252`). Log at `debug` when cache misses.
- **Lifetime:** in-memory, per-process. Clear on `dispose?: () => Promise<void>` hook if you implement it: `modelBySession.clear()`. No persistence needed.
- **Alternative path for Option B (core tool):** `Tool.Context` in core *can* be extended or `SessionV2` consulted via `InstanceState`; but prefer the same hook pattern for consistency.

**Edge cases to cover:**
- Tool called before any `chat.params` has fired (first turn, cached `undefined`).
- Model switch mid-session (`chat.params` overwrites correctly because it fires before each LLM request).
- Stale `sessionID` memory leak — prune entries older than N sessions or on `dispose`; bound map size to e.g. 200 entries.

### 4.3 SVG validation & sanitization (`src/validate.ts`)

Must defend before rasterization (`PLUGIN.md:259-270`):

- **Well-formedness:** parse as XML. Use a lightweight parser (`fast-xml-parser`, `xmldom`, or raw `DOMParser` if available in Bun). Reject with a precise `InvalidArgumentsError`-style message so the model can self-correct (e.g. `"SVG parse error at line 3: unclosed <rect> tag"`).
- **Size cap:** `svg.length > maxSvgBytes` → error.
- **Root check:** document element must be `<svg` (case-sensitive). Else error.
- **Strip/reject list** (reject the call, do not silently mutate, unless mutation is safe and documented):
  - `<script` / `</script>` (any case, any namespace)
  - `on*` attributes (`onclick`, `onload`, `onerror`, etc.) — regex `\bon\w+\s*=` on raw markup pre-parse plus attribute check post-parse.
  - `<foreignObject>` — reject or strip (re-enable only if you can sandbox HTML; recommendation: reject).
  - External references: `href=`, `xlink:href=`, `url(`, `@import`, `<image href>`, `<use href>` pointing to `http:|https:|data:` outside inline `data:image/*` allowlist; also `//` protocol-relative.
  - `style` attributes/elements containing `url(` or `@import`.
- **Bomb guards:**
  - Nesting depth cap (e.g. 128).
  - `<use>` / `<pattern>` expansion budget.
  - `width * height <= maxPixels` (use intrinsic SVG width/height or supplied `width`/`height` args; cap at 4096 each already).

Return a sanitized `string` (if you strip) or the original if you only reject. Keep function pure/sync:

```ts
export function validateSvg(svg: string, opts: { maxSvgBytes: number; maxPixels: number; width?: number; height?: number }): string
// throws ValidateError with model-facing message
```

**Tests for this file alone:** see §7.1.

### 4.4 Rasterization (`src/rasterize.ts`)

- Dependency: `@resvg/resvg-wasm`. On first call, init WASM (`await initWasm(wasmBytes)` or `Resvg` auto-init depending on version). Cache the initialized module / font collection.
- API sketch:
  ```ts
  export type PngResult = { bytes: Uint8Array; width: number; height: number; base64: string }
  export async function rasterizeSvg(svg: string, opts: {
    width?: number; height?: number; background: "white" | "transparent"
  }): Promise<PngResult>
  ```
- Map `background: "white"` → `background: "white"` or `"#ffffff"` in resvg `fitTo`/`background` config; `"transparent"` → no background / `rgba(0,0,0,0)`.
- Apply `width`/`height` overrides via `fitTo: { mode: "width", value: width }` or explicit viewport. Default to SVG intrinsic `width`/`viewBox` or 1024 (`PLUGIN.md:211`).
- Encode to PNG (resvg does this), base64-encode (`Buffer.from(bytes).toString("base64")`), return URL-ready string.
- **No network:** resvg must not fetch. The validator has already stripped external refs; additionally, pass `imageRendering` / font loading that does not hit network, and do not load system fonts beyond what WASM bundles (or bundle `Noto Sans` if needed).
- **Determinism:** no randomness, no timestamps in PNG metadata.
- **Failure modes:** catch resvg throws, wrap as `RenderError` with a generic model-facing message (`"SVG render failed: <reason>"`) but preserve detail in `metadata` for human debugging.

### 4.5 Render cache (`src/cache.ts`)

`PLUGIN.md:283-293`:

```ts
export function cachePaths(worktree: string, sessionID: string, callID: string) { // callID from ctx.messageID or ulid
  const dir = path.join(worktree, ".opencode", "render-svg", sessionID)
  return { dir, svg: path.join(dir, `${callID}.svg`), png: path.join(dir, `${callID}.png`) }
}
```

- `ctx.callID` is preferred if present (`opencode/packages/opencode/src/tool/tool.ts: Context.callID?`); fallback to `ctx.messageID + "-" + Date.now()` or `ulid()`. Import `ulid` from the same package core uses if available.
- Ensure dir exists (`await Bun.write` or `mkdir -p`). Use `Bun.file` / `fs/promises` consistently with the rest of the codebase (`opencode/AGENTS.md` prefers `Bun.file()` where applicable, but either is fine for plugin code).
- Write both `.svg` (sanitized markup) and `.png` (bytes). Paths are referenced in `metadata.cachePath` for both branches and in `metadata.preview` for Path B.

### 4.6 Summary generator (`src/summarize.ts`)

For Path B terminal visibility (`PLUGIN.md:338`, `PLUGIN.md:371-383`):

```ts
export function summarizeSvg(svg: string): string
// e.g. "3 <rect>, 2 <path>, 1 <circle>, viewBox 0 0 800 600, 1243 bytes"
```

- Count element types by regex or parsed DOM: `rect|path|circle|ellipse|line|polygon|polyline|text|g|defs|use|image`.
- Extract `viewBox`, `width`, `height`, `xmlns`.
- Include byte length, truncated preview of first 200 chars if useful.
- Keep output under ~300 chars — it appears in the permission dialog and terminal transcript.

### 4.7 Verification (Phase 2)

```bash
bun tsc --noEmit
bun test test/validate.test.ts
bun test test/rasterize.test.ts
# Manual smoke:
bun -e "import {validateSvg} from './src/validate.ts'; console.log(validateSvg('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"100\"><rect width=\"100\" height=\"100\" fill=\"red\"/></svg>',{maxSvgBytes:256000,maxPixels:4_000_000}))"
```

Criteria: validator rejects all fixtures in `test/fixtures/` malicious cases, accepts valid ones; rasterizer produces valid PNG (check PNG magic bytes `89 50 4E 47`), `width*height` cap enforced.

---

## 5. Phase 3 — Tool definition & shared execute preamble

### 5.1 Tool wiring (`src/render_svg.ts` or `src/index.ts`)

Canonical shape (merge `PLUGIN.md:198-218` with plugin API `opencode/packages/plugin/src/tool.ts:1`):

```ts
import { tool } from "@opencode-ai/plugin"
import DESCRIPTION from "./render_svg.txt" with { type: "text" } // or Bun.file read / import assertion per bundler
import { validateSvg } from "./validate.ts"
import { rasterizeSvg } from "./rasterize.ts"
import { cachePaths } from "./cache.ts"
import { summarizeSvg } from "./summarize.ts"
import open from "open"

export const renderSvgTool = tool({
  description: DESCRIPTION.trim(),
  args: {
    svg: tool.schema.string().describe("Complete, self-contained SVG markup (must start with <svg ...> and be well-formed XML). Do not reference external files, fonts, or URLs."),
    title: tool.schema.string().optional().describe("Short human-readable title for this render."),
    width: tool.schema.number().int().positive().max(4096).optional().describe("Rasterization width in px. Defaults to the SVG's intrinsic width or 1024."),
    height: tool.schema.number().int().positive().max(4096).optional(),
    background: tool.schema.enum(["transparent", "white"]).optional().default("white"),
  },
  async execute(args, ctx) {
    // shared preamble → branch on isMultimodal (+ forceHumanReview)
  }
})
```

Notes:
- House style elsewhere loads descriptions from `*.txt` via `import DESCRIPTION from "./read.txt"` (`opencode/packages/opencode/src/tool/read.ts:1` does `import DESCRIPTION from "./read.txt"`). Replicate that.
- Keep `args` exactly as specced; do not add `path`, `url`, or `file` args — input is always inline markup.
- For Option B (core `Tool.define`), shape is `Tool.define("render_svg", Effect.gen(...))` with `Schema.String` parameters and `ExecuteResult` return; adapt accordingly but keep the same `args` semantics.

### 5.2 Shared preamble inside `execute`

Every call does, in order (mirrors `PLUGIN.md:152-193`):

1. **Validate & sanitize** — `validateSvg(args.svg, { maxSvgBytes, maxPixels, width: args.width, height: args.height })`. On throw, surface as `InvalidArgumentsError`-style so the model can retry (the plugin bridge will turn a thrown `Error` into a tool error string the model sees).
2. **Rasterize** — `await rasterizeSvg(sanitizedSvg, { width: args.width, height: args.height, background: args.background ?? defaultBackground })`. On failure, throw a wrapped error (`"SVG render failed: ..."`) — no partial attachments.
3. **Resolve capability** — `const model = modelBySession.get(ctx.sessionID); const isMultimodal = model?.capabilities.input.image === true`.
4. **Apply override** — `const useHumanPath = forceHumanReview || !isMultimodal`. (`PLUGIN.md:417` — `forceHumanReview` flag makes even multimodal models take Path B.)
5. Dispatch to Path A or Path B (§6, §7).

**Error contracts:** malformed SVG / disallowed content → model-correctable error; rasterizer crash → generic failure; never return a half-written attachment.

### 5.3 Verification (Phase 3)

- `bun tsc --noEmit` still passes.
- Call the tool in-process with a minimal valid SVG and assert it returns either `{ attachments, output }` (Path A) or attempts `ctx.ask` (Path B) depending on a faked `modelBySession` entry.

---

## 6. Phase 4 — Path A: multimodal (`PLUGIN.md:298-328`)

```ts
if (!useHumanPath) {
  // isMultimodal === true and not forced
  return {
    title: args.title ?? "Rendered SVG",
    output: `Rendered a ${png.width}x${png.height} PNG from the provided SVG. Review the attached image and continue iterating if anything looks wrong.`,
    metadata: { svgBytes: args.svg.length, width: png.width, height: png.height, cachePath },
    attachments: [
      { type: "file", mime: "image/png", url: `data:image/png;base64,${png.base64}` },
    ],
  }
}
```

**Design constraints:**

- **Do not call `ctx.ask()`** on this path. Adding a permission gate silently converts Path A into Path B and defeats multimodal self-iteration (`PLUGIN.md:315-327`). Gate only if `forceHumanReview` is set (handled by `useHumanPath` above).
- **Do not branch on provider** for attachment transport. `opencode/packages/opencode/src/session/message-v2.ts:147-311` already handles inline `tool_result` vs synthetic `user` follow-up per `supportsMediaInToolResult`. The plugin only decides *whether* to attach.
- Optionally, still write to cache on Path A for audit/debug and include `cachePath` in `metadata` (recommended even though not required by spec). It aids replay and human inspection of multimodal runs.

**Verification:**

- With `modelBySession.set(sessionID, { capabilities: { input: { image: true } } } as any)`, the tool returns `attachments.length === 1`, `mime === "image/png"`, `url` starts with `data:image/png;base64,`, and PNG decodes to expected dimensions.
- Web/desktop client would render `<img src={url}>` (`opencode/packages/session-ui/src/components/message-part.tsx`); TUI correctly shows no image but transcript shows `output` text.

---

## 7. Phase 5 — Path B: human review (`PLUGIN.md:330-391`)

```ts
// useHumanPath === true
const { svg: svgPath, png: pngPath, dir } = cachePaths(ctx.worktree, ctx.sessionID, ctx.callID ?? ctx.messageID)
await Bun.write(svgPath, sanitizedSvg)          // or fs.writeFile
await Bun.write(pngPath, png.bytes)
if (autoOpenViewer) {
  await open(pngPath).catch(() => {})           // best-effort; never block on opener failure (PLUGIN.md:401)
}
const summary = summarizeSvg(sanitizedSvg)

try {
  await ctx.ask({
    permission: "render_svg",
    patterns: [pngPath],
    always: ["*"],
    metadata: {
      title: args.title ?? "SVG render awaiting review",
      cachePath: pngPath,
      summary,
      preview: `data:image/png;base64,${png.base64}`, // web/desktop shows inline even though model can't
    },
  })
} catch (err) {
  // PermissionV1.RejectedError / CorrectedError — rethrow as-is.
  // The framework turns err.message into the tool error the model reads
  // (opencode/packages/opencode/src/session/processor.ts::failToolCall).
  throw err
}

return {
  title: args.title ?? "Rendered SVG (approved)",
  output: `Render approved by user. Saved to ${svgPath}. ${summary}`,
  metadata: { cachePath: svgPath, width: png.width, height: png.height },
  // No attachments — model can't consume it; would waste tokens (PLUGIN.md:365)
}
```

**Why this satisfies "presents the output in the terminal" (`PLUGIN.md:371-383`):**

1. Textual `summary` in transcript — visible even without a viewer.
2. OS viewer via `open(pngPath)` — mirrors `opencode/packages/opencode/src/cli/cmd/web.ts:75` / `opencode/packages/opencode/src/mcp/browser.ts:1` pattern.
3. Permission dialog — TUI shows approve/once/always/reject; web/desktop additionally renders `metadata.preview` as an inline image.

**`ctx.ask` contract to get right:**

- Field names must be `permission`, `patterns`, `always`, `metadata` (`opencode/packages/plugin/src/tool.ts: AskInput`). Do not invent `title` at top level.
- `permission: "render_svg"` — matches the rule key users would configure in `opencode.json#permission`.
- `always: ["*"]` allows the user to permanently approve `render_svg` (evaluated in `opencode/packages/opencode/src/permission/index.ts::evaluate`).
- `patterns` is what `always` rules match against; `pngPath` is appropriate. Do not use `svgPath` alone or a glob the user can't reason about.
- Rejections: tests must assert that `throw err` preserves `err.message` verbatim (`"The user rejected permission ... with the following feedback: {text}"` from `opencode/packages/core/src/v1/permission.ts: CorrectedError`).

**`autoOpenViewer` behavior:**

- When `false` (headless/CI), skip `open()` entirely. Still write cache and call `ctx.ask()` — the user can inspect at `cachePath` manually.

**Verification:**

- Mock `ctx.ask` to (a) resolve, (b) reject with `CorrectedError("make the circle bigger")`, (c) reject with bare `RejectedError`. Assert:
  - (a) returns `output` containing `"approved"` + `summary` + `cachePath`.
  - (b/c) the thrown error's `.message` is exactly what the model would see; `PLUGIN.md:399` strings match.
- Mock `open` failure — assert `ctx.ask` still called and error is swallowed.
- Empty capability cache → takes Path B (safe default, `PLUGIN.md:402`).

---

## 8. Phase 6 — Configuration, cache hygiene, and polish

### 8.1 Plugin options wiring

Follow `opencode/packages/plugin/src/index.ts:68-76` (`Plugin = (input, options?) => Promise<Hooks>`; `PluginOptions = Record<string, unknown>`):

```ts
export const RenderSvgPlugin: Plugin = async (input, rawOptions) => {
  const opts = { ...DEFAULTS, ...(rawOptions as RenderSvgOptions) }
  // validate opts (e.g. maxSvgBytes > 0) and clamp
  // close over opts in tool execute
}
```

Document consumption in `opencode.json`:

```json
{
  "plugin": [
    ["opencode-plugin-render-svg", {
      "maxSvgBytes": 262144,
      "maxPixels": 4000000,
      "defaultBackground": "white",
      "autoOpenViewer": true,
      "forceHumanReview": false,
      "cacheDir": ".opencode/render-svg"
    }]
  ]
}
```

### 8.2 Cache directory customization

If `cacheDir` is set, resolve relative to `worktree` (`path.resolve(ctx.worktree, cacheDir)`); absolute paths resolved as-is. Ensure both Paths respect it.

### 8.3 Background choices

- Use `Bun.file`/`Bun.write` where possible per `opencode/AGENTS.md` style; `fs/promises` is acceptable in plugin code that may run outside Bun.
- No `any`, no star imports, no aliased imports (`opencode/AGENTS.md: Imports`).
- Prefer `const`, ternaries, early returns over `let`/`else` (`opencode/AGENTS.md: Control Flow`).
- Keep helpers pure/sync unless they are `Effect`-based (core-side only).
- Do **not** invent a `truncation-dir.ts` analogue — `render_svg` output is short by construction.

### 8.4 Git hygiene

- Ensure `.gitignore` covers the render cache:
  ```
  .opencode/render-svg/
  ```
  (For Option A, put this in `oc-svgrender/.gitignore` and document that consuming projects should add it to their own `.gitignore`.)
- Do not commit `*.png` / `*.svg` fixtures beyond `test/fixtures/` minimal samples.

---

## 9. Phase 7 — Testing

### 9.1 Unit tests

| File | Cases |
|---|---|
| `test/validate.test.ts` | Accepts minimal valid SVG; rejects missing root, parse error, `<script>`, `onload=`, `<foreignObject>`, external `href`/`url()`, size over `maxSvgBytes`, pixel area over `maxPixels`; depth cap. |
| `test/rasterize.test.ts` | Renders 100x100 red rect to PNG with correct magic bytes and dimensions; `width`/`height` override; `background` white vs transparent produces different bytes; invalid SVG throws `RenderError`. |
| `test/summarize.test.ts` | Counts elements, extracts `viewBox`, formats under 300 chars. |
| `test/cache.test.ts` | `cachePaths` layout is `{worktree}/.opencode/render-svg/{sessionID}/{callID}.{svg,png}` (or custom `cacheDir`); dir creation. |

### 9.2 Integration / routing tests (`test/render_svg.test.ts`)

Mock `ToolContext` (`sessionID`, `messageID`, `worktree` → `tmpdir`, `ask: vi.fn()`, `metadata: vi.fn()`, `abort: new AbortController().signal`):

- **Path A:** inject `modelBySession.set(sessionID, multimodalModel)`; valid SVG → `attachments[0].mime === "image/png"`; `output` invites self-critique; `ctx.ask` not called; cache optionally written.
- **Path B approved:** empty/multimodal-false cache; `ctx.ask` resolves → `output` contains `approved` + `summary`; `open` called once (mock `open` module).
- **Path B rejected with message:** `ctx.ask` rejects `CorrectedError("nope")` → thrown error message contains `"nope"`; verify `failToolCall` would surface it (assert `error.message`).
- **Path B rejected without message:** `RejectedError` → message is `"The user rejected permission ..."`.
- **Empty cache fallback:** no `chat.params` entry → Path B.
- **forceHumanReview:** multimodal true but `forceHumanReview: true` → Path B.
- **autoOpenViewer=false:** `open` not called.
- **Invalid SVG:** validator throws → no rasterize, no ask, error is model-correctable.

Use `bun:test` (aligns with repo's `bun.lock` and `opencode`'s runner) or `vitest` if preferred; do not introduce `jest` globals.

### 9.3 Manual end-to-end

1. **Multimodal sim:** run a test harness that sets `modelBySession` to a fake image-capable model, calls the tool, and inspects that `data:image/png;base64,` decodes to a viewable PNG. Open the PNG manually.
2. **Human path:** `bun --cwd packages/opencode dev` in a tmux session is not needed for the standalone plugin (there is no TUI to start), but you can exercise `open()` + `ctx.ask()` via a stub CLI that calls `render_svg` and prints `metadata.preview` length.
3. **Viewer check:** on macOS run `open` path in Terminal; on Linux `xdg-open`; on CI set `autoOpenViewer: false`.

### 9.4 Typecheck & lint

```bash
bun tsc --noEmit
bunx oxlint src  # if you adopt opencode's linter (see opencode/package.json: lint)
```

Follow `opencode/AGENTS.md: Testing` (no mocks unless needed, test real impl) and `opencode/AGENTS.md: Type Checking` (run `bun typecheck` from package dir, not bare `tsc` if you align with plugin's `package.json` scripts).

**Coverage target:** `validate.ts` and routing branches at 90%+ (small surface, high leverage); `rasterize.ts` needs at least one golden PNG byte check.

---

## 10. Phase 8 — Security hardening (checklist)

- [ ] Validator runs **before** rasterizer; stripped markup is what gets rasterized, cached, and shown to human.
- [ ] No raw `svg` string is ever sent to a client as `image/svg+xml`; only rasterized `image/png` (`data:image/png;base64,`) is attached or in `metadata.preview` (`PLUGIN.md:426-431`).
- [ ] Resvg is configured to **not** fetch network resources. Add a test that an SVG with `<image href="https://example.com/x.png">` either fails validation or renders without performing a fetch (stub `fetch` and assert not called).
- [ ] `ctx.ask`'s `always` pattern does not introduce a wildcard allow for unrelated permissions — scope is `permission: "render_svg"` only.
- [ ] Document that `forceHumanReview` is the intended control for deployments that require human gate even for multimodal models (`PLUGIN.md:324`).

---

## 11. Phase 9 — Documentation & distribution

- [ ] `README.md` (new, allowed — user explicitly requested docs via this plan): install, `opencode.json` snippet, args table, Path A vs B explanation with diagram from `PLUGIN.md:152-194`, config table from `PLUGIN.md:407-422`, troubleshooting (WASM init, `open` failures, permission `always`).
- [ ] `src/render_svg.txt` — keep in sync with `README` args table.
- [ ] `CHANGELOG.md` if publishing.
- [ ] `LICENSE` — already present.
- [ ] Publishing (if standalone): `bun publish` or `npm publish`; verify `exports` field and `files` include `src/` + WASM assets.
- [ ] Consumer `.gitignore` note for `.opencode/render-svg/`.

For Option B (in-tree), documentation lives in `opencode`'s tool registry and `opencode.json` schema instead; update `opencode/packages/opencode/src/tool/*.txt` index if one exists.

---

## 12. Milestones & acceptance criteria

| Milestone | Done when | Artifact |
|---|---|---|
| **M1 Scaffolding** | Package installs, `tsc` passes, `render_svg.txt` exists | `package.json`, `src/` skeleton |
| **M2 Shared libs** | Validator + rasterizer + cache + summary pass unit tests | `src/validate.ts`, `src/rasterize.ts`, `src/cache.ts`, `src/summarize.ts`, `test/fixtures/` |
| **M3 Capability cache** | `chat.params` hook populates `modelBySession`; empty-cache fallback is Path B | `src/index.ts` hook + test |
| **M4 Tool wired** | `render_svg` registered via `Plugin` and callable with valid SVG | `src/render_svg.ts` + `src/index.ts#tool` |
| **M5 Path A** | Multimodal call returns PNG attachment, no `ask` | Integration test green |
| **M6 Path B** | Non-multimodal call writes cache, calls `open` (swallowed on fail), blocks on `ask`, propagates `CorrectedError` | Integration test green |
| **M7 Config & polish** | All `RenderSvgOptions` honored, cache dir customizable, `AGENTS.md`/`README` accurate | `src/config.ts`, docs |
| **M8 Hardening** | Security checklist passes, no raw SVG to clients, no network fetch | Security tests |
| **M9 Release** | `bun tsc --noEmit` + all tests green on macOS/Linux, manual PNG viewable | Tag + publish |

Global acceptance: `PLUGIN.md:395-446` behavior table and `PLUGIN.md:152-194` flow are fully realized with reused OpenCode primitives, not reimplemented.

---

## 13. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `chat.params` hook signature drift | Capability cache breaks | Pin `@opencode-ai/plugin` version; re-verify §2 checklist on upgrade; fall back to Path B on miss (safe). |
| WASM init cost on first call | Latency spike, timeout | Lazy-init and cache promise; add `await initWasm` with 5s timeout that falls back to clear error. |
| `open()` not available (headless/SSH) | Viewer fails | Honor `autoOpenViewer: false`; always swallow `open` rejection; include `cachePath` so user can `cat`/`scp`. |
| Bun vs Node `import ... with {type}` | Description load fails | Use `Bun.file` read for `render_svg.txt` if static import is unsupported in consumer's bundler; provide both paths. |
| SVG bomb (deeply nested `<use>`) | OOM | Depth cap + `maxPixels` + `maxSvgBytes` enforced in validator, not just rasterizer. |
| Model sends 500KB+ SVG | Token/memory bloat | Hard cap at 256KB; error message explicitly tells model the limit (self-correctable). |

---

## 14. Appendix — key file references

- Plugin API: `opencode/packages/plugin/src/tool.ts:1`, `opencode/packages/plugin/src/index.ts:1` (`Plugin`, `Hooks["chat.params"]`, `ToolContext.ask`)
- Host bridge: `opencode/packages/opencode/src/tool/registry.ts:143-153` (`bridge.promise(toolCtx.ask(req))`)
- Attachments precedent: `opencode/packages/opencode/src/tool/read.ts:1`
- Attachment transport: `opencode/packages/opencode/src/session/message-v2.ts:147-311`
- Capabilities: `opencode/packages/sdk/js/src/gen/types.gen.ts` → `Model.capabilities.input.image`, mapped in `opencode/packages/opencode/src/provider/provider.ts:1291`
- Permissions: `opencode/packages/opencode/src/permission/index.ts:1`, `opencode/packages/core/src/v1/permission.ts:1`
- Image pipeline (raster-only): `opencode/packages/opencode/src/image/image.ts:1` (Photon/WASM, no SVG)
- `open()` precedent: `opencode/packages/opencode/src/cli/cmd/web.ts:6,75`, `opencode/packages/opencode/src/mcp/browser.ts:1`
- House txt convention: `opencode/packages/opencode/src/tool/read.txt:1` / `write.txt:1`

---

## 15. Quick-start for an agent picking this up

```bash
# 0) orient
cat PLUGIN.md | head -n 60
cat opencode/packages/plugin/src/tool.ts
cat opencode/packages/plugin/src/index.ts | grep -A 15 '"chat.params"'

# 1) scaffold (Option A)
bun install --cwd .  # after creating package.json at repo root
bun tsc --noEmit

# 2) implement validate → rasterize → cache → summarize
bun test

# 3) wire plugin + dual path, then run routing tests
bun test test/render_svg.test.ts
```

Keep commits scoped per `opencode/AGENTS.md: Commits and PR Titles` (`feat(plugin): ...`, `fix(render-svg): ...`). Branch names: at most three hyphen-separated words, no slashes (`render-svg-tool`, `svg-validation`, `human-review-path` per `opencode/AGENTS.md: Branch Names`).
