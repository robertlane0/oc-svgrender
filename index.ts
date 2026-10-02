/**
 * Package entrypoint.
 *
 * OpenCode resolves a plugin installed as a local directory by probing
 * `<package>/server` and then the package root, and it resolves the *directory*,
 * not the `exports` map: a package whose `main` points into `src/` (with no
 * root-level entry file) is skipped silently. Both files below therefore exist
 * as re-exports of `src/index.ts`, which holds the implementation.
 */
export { default, ID, RenderSvgPlugin } from "./src/index.ts"
