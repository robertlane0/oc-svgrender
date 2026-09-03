import { describe, expect, test } from "bun:test"
import { mkdtemp, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { cachePaths, ensureCacheDir, sanitizeSegment, writeCache } from "../src/cache.ts"

describe("cache", () => {
  test("layout is {worktree}/{cacheDir}/{session}/{call}.{svg,png}", () => {
    const p = cachePaths("/wt", "sesABC", "call1")
    expect(p.dir).toBe(path.join("/wt", ".opencode", "render-svg", "sesABC"))
    expect(p.svg).toBe(path.join(p.dir, "call1.svg"))
    expect(p.png).toBe(path.join(p.dir, "call1.png"))
  })

  test("custom relative cacheDir resolves under worktree", () => {
    const p = cachePaths("/wt", "s", "c", "custom/cache")
    expect(p.dir).toBe(path.join("/wt", "custom", "cache", "s"))
  })

  test("absolute cacheDir used as-is", () => {
    const p = cachePaths("/wt", "s", "c", "/abs/cache")
    expect(p.dir).toBe(path.join("/abs", "cache", "s"))
  })

  test("segments are sanitized", () => {
    expect(sanitizeSegment("../../etc")).not.toContain("/")
    expect(sanitizeSegment("")).toBe("call")
  })

  test("writeCache creates dir and writes both files", async () => {
    const wt = await mkdtemp(path.join(tmpdir(), "render-svg-cache-"))
    const p = cachePaths(wt, "ses", "call")
    await writeCache(p, "<svg/>", new Uint8Array([1, 2, 3]))
    expect((await stat(p.svg)).isFile()).toBe(true)
    expect((await stat(p.png)).isFile()).toBe(true)
    await ensureCacheDir(p.dir) // idempotent
  })
})
