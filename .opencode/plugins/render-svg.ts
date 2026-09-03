/**
 * Project-level install of the render_svg plugin.
 *
 * Source of truth lives in ../../src/ (tested, versioned with this repo).
 * This file only re-exports the plugin function so OpenCode's local-plugin
 * loader (`.opencode/plugins/`) picks it up at startup.
 */
export { RenderSvgPlugin } from "../../src/index.ts"
