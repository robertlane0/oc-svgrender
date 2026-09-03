# opencode-plugin-render-svg

An OpenCode plugin providing a single tool, `render_svg`, that lets a model **draw**:
it renders model-authored SVG markup to PNG and routes the result through the
review loop that actually works for the calling model.

- **Path A — multimodal models** (`capabilities.input.image === true`): the PNG
  is attached to the tool result so the model sees its own render next turn and
  can iterate without human involvement.
- **Path B — text-only models (or `forceHumanReview`)**: the render is written
  to a workspace cache, opened in the OS viewer, and gated on human
  approve/reject via `ctx.ask()`. Rejection feedback propagates back to the
  model as the tool error.

Spec: [`PLUGIN.md`](./PLUGIN.md). Build plan: [`AGENTS.md`](./AGENTS.md).

## Install

**This project (already wired):** `.opencode/plugins/render-svg.ts`
re-exports the plugin from `src/`; runtime deps live in
`.opencode/package.json` (installed via `bun install` in `.opencode/`).
OpenCode picks up project plugins automatically at startup — verified with
`opencode debug config` (appears as a `local`-scope plugin).

**Another project:** copy `src/` into your plugin setup (or publish this
package and add it to `opencode.json`):

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

> Note: `plugin: [...]` entries in `opencode.json` are for npm packages.
> For a local checkout, use the `.opencode/plugins/*.ts` re-export pattern
> shown in [`.opencode/plugins/render-svg.ts`](.opencode/plugins/render-svg.ts)
> (no options channel — defaults apply) and add the dependencies to
> `.opencode/package.json`. Consumers should also gitignore the render cache
> (`.opencode/render-svg/`).

## Tool args

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
| `autoOpenViewer` | `true` | `open()` the PNG on Path B. Set `false` headless/CI. Failures are swallowed; `cachePath` is always reported. |
| `forceHumanReview` | `false` | Route even multimodal models through Path B. |
| `cacheDir` | `".opencode/render-svg"` | Relative (to worktree) or absolute render-cache root. |

## Develop

```bash
bun install
bunx tsc --noEmit
bun test
```

Live check in this repo (requires this OpenCode instance):

```bash
opencode debug config   # render-svg.ts listed as a local plugin
opencode run --auto "Call the render_svg tool once with title 'smoke' and this svg: <svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><circle cx='60' cy='60' r='50' fill='red'/></svg>. Then reply DONE."
```

## Security

- Validation runs before rasterization; only the validated markup is rendered,
  cached, or shown.
- Rejected: `<script>`, `on*` attributes, `<foreignObject>`, external
  `href`/`url()`/`@import` (only `#fragment` refs and `data:image/*` inlines
  pass), oversize input, deep nesting (>128), `<use>`/`<pattern>` floods.
- Only rasterized `image/png` (`data:image/png;base64,…`) ever reaches a
  client — raw SVG is never attached or previewed.
- The rasterizer never resolves remote resources (no network fetch).
