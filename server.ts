/**
 * Server entrypoint for OpenCode's plugin loader.
 *
 * `Host.resolve()` probes `<package>/server` before falling back to the package
 * root, and it only falls back on errors it recognises as resolution failures.
 * Resolving a package that has no `server` file can therefore abort the probe
 * before the root entry is ever tried, which is why this file exists even though
 * `index.ts` would also resolve. It is a re-export, not a second implementation.
 */
export { default, ID, RenderSvgPlugin } from "./src/index.ts"
