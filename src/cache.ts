/**
 * Render-cache paths + I/O. Layout per PLUGIN.md §4.4:
 *   {worktree}/{cacheDir}/{sessionID}/{callID}.{svg,png}
 */
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"

export type CachePaths = {
  dir: string
  svg: string
  png: string
}

export function sanitizeSegment(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80)
  return cleaned.length > 0 ? cleaned : "call"
}

export function cachePaths(
  worktree: string,
  sessionID: string,
  callID: string,
  cacheDir = ".opencode/render-svg",
): CachePaths {
  const base = path.isAbsolute(cacheDir) ? cacheDir : path.join(worktree, cacheDir)
  const dir = path.join(base, sanitizeSegment(sessionID))
  const name = sanitizeSegment(callID)
  return { dir, svg: path.join(dir, `${name}.svg`), png: path.join(dir, `${name}.png`) }
}

export async function ensureCacheDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export async function writeCache(paths: CachePaths, svg: string, png: Uint8Array): Promise<void> {
  await ensureCacheDir(paths.dir)
  await writeFile(paths.svg, svg, "utf8")
  await writeFile(paths.png, png)
}
