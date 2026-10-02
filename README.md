# opencode-plugin-render-svg

An OpenCode plugin providing a single tool, `render_svg`, that lets a model **draw**:
it renders model-authored SVG markup to PNG and routes the result through the
review loop that actually works for the calling model.

- **Path A — multimodal models** (`capabilities.input` contains `image`): the PNG
  rides along on the tool result as an `image/png` content part, so the model sees
  its own render on the next turn and iterates without human involvement.
- **Path B — text-only models (or `forceHumanReview`)**: no image is attached
  (OpenCode rewrites an image part into a "this model does not support image
  input" error for text-only models). The render is written to a workspace
  cache, opened in the OS image viewer, and the model gets a structural summary
  plus the file path.

Requires **OpenCode v2** (`>=2.0.0`, the plugin API in `@opencode/plugin`).
Spec: [`PLUGIN.md`](./PLUGIN.md). Build plan: [`AGENTS.md`](./AGENTS.md).

## Install

Add the package to `opencode.json` (the object form carries options):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-plugin-render-svg",
      "options": {
        "maxSvgBytes": 262144,
        "maxPixels": 4000000,
        "defaultBackground": "white",
        "autoOpenViewer": true,
        "forceHumanReview": false,
        "cacheDir": ".opencode/render-svg"
      }
    }
  ]
}
```

A local checkout works the same way — point `package` at the directory and OpenCode
watches it, so edits reload without a restart:

```json
{ "plugins": [{ "package": "/path/to/oc-svgrender" }] }
```

This repository is installed into the local instance at
`~/.config/opencode/opencode.json`. Consumers should gitignore the render cache
(`.opencode/render-svg/`).

## Tool args

The tool input is plain JSON Schema (`svg` is the only required key).

| Arg | Required | Description |
|---|---|---|
| `svg` | yes | Complete, self-contained SVG markup (must start with `<svg …>`, well-formed XML). No external files, fonts, or URLs. |
| `title` | no | Short human-readable title for the render. |
| `width` | no | Rasterization width in px (int, 1–4096). Defaults to intrinsic width or 1024. |
| `height` | no | Rasterization height in px (int, 1–4096). |
| `background` | no | `"white"` (default) or `"transparent"`. Falls back to `defaultBackground` when omitted. |

## Config options

| Option | Default | Description |
|---|---|---|
| `maxSvgBytes` | `256_000` | Reject larger SVG input (model-correctable error). |
| `maxPixels` | `4_000_000` | Reject `width × height` above this (bomb guard). |
| `defaultBackground` | `"white"` | Used when the call omits `background`. |
| `autoOpenViewer` | `true` | `open()` the PNG on Path B (non-blocking, failures swallowed). Set `false` headless/CI. |
| `forceHumanReview` | `false` | Route even multimodal models through Path B. |
| `cacheDir` | `".opencode/render-svg"` | Relative (to `ctx.location.directory`) or absolute render-cache root. |

## Human review and permissions

V1 gated Path B on `ctx.ask()`, so a human could approve or reject a render and
their feedback came back as the tool error. **OpenCode v2 gives plugins no
permission-prompt API** — `ctx.permission` is `list`/`get`/`reply` only, and
permission requests are created by core tools that hold the `Permission` service,
which an external plugin cannot reach.

What that means here:

- Path B is now *visible* human review, not a blocking gate: the PNG is cached,
  opened in the OS viewer, and its `data:` URL is published in the tool
  `metadata` (a UI-only channel the model never sees).
- The tool declares `options.permission: "render_svg"`, so configuration is the
  gate. A `deny` rule removes it from the model's catalog entirely:

  ```json
  { "permission": { "render_svg": "deny" } }
  ```

  Restoring an interactive approve/reject prompt for renders needs a core change
  (a plugin-facing permission-request API) or a TUI plugin that drives the review
  dialog itself.

## Verified against OpenCode v2.0.21

Installed into the local instance at `~/.config/opencode/opencode.json` (or, for
a checkout like this one, auto-discovered from `.opencode/plugins/render-svg.ts`,
which OpenCode watches and hot-reloads). Both routes were exercised end to end
with `opencode run --model <model>`:

- `opencode/space-bunny-free` (image input) → `route: "multimodal"`, the tool
  result carries the `image/png` data URL, and the model answers questions about
  the render.
- `opencode/big-pickle` (text only) → `route: "human"`, no image part, and the
  result is the path plus structural summary.

Three host-facing bugs surfaced during that testing and are fixed here, each with
a regression test:

1. **Metadata must be pure JSON.** `session.tool.success` encodes metadata as
   `Record<string, Json>`; an explicit `undefined` value fails the encode, the
   event never publishes, and the model sees "Provider did not return a tool
   result" instead of the render. Keys are now dropped rather than set to
   `undefined` (`src/render_svg.ts`, `metadata()`).
2. **The rasterizer memo must be process-wide.** OpenCode re-evaluates a local
   plugin's module graph on every watched file change, and resvg's `initWasm()`
   is one-shot per process. The memo now lives on a `Symbol.for` key on
   `globalThis` instead of in module scope (`src/rasterize.ts`).
3. **Capability lookups must be bounded.** A cold `ctx.model.list()` can block on
   a slow catalog fetch. Since OpenCode marks a still-running tool as missing and
   moves on, the lookup has a time budget and degrades to the text-only route
   rather than stalling the step (`src/models.ts`).

## Develop

```bash
bun install
bun run typecheck
bun test
```

Live check against the local instance:

```bash
opencode debug config                       # plugin listed as a local package
opencode run --model opencode/space-bunny-free \
  "Call render_svg once with a red circle SVG, then tell me which corner of the image it sits in. Finish with DONE."
```

A vision-capable model answers the corner question only if it really saw the
render; `big-pickle` (text-only) instead gets the summary and a file path.

## Security

- Validation runs before rasterization; only the validated markup is rendered,
  cached, or shown.
- Rejected: `<script>`, `on*` attributes, `<foreignObject>`, external
  `href`/`url()`/`@import` (only `#fragment` refs and `data:image/*` inlines
  pass), oversize input, deep nesting (>128), `<use>`/`<pattern>` floods.
- Only rasterized `image/png` (`data:image/png;base64,…`) ever reaches a
  client — raw SVG is never attached or previewed.
- The rasterizer never resolves remote resources (no network fetch).
- The tool never rejects: OpenCode v2 runs promise tools inside `Effect.promise`,
  where a thrown error becomes a defect that ends the step. Every failure is
  returned as model-readable text instead.
