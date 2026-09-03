/**
 * Textual summary of an SVG for terminal visibility (Path B).
 * Keeps output under ~300 chars for the permission dialog / transcript.
 */

const COUNTED = [
  "rect",
  "path",
  "circle",
  "ellipse",
  "line",
  "polygon",
  "polyline",
  "text",
  "g",
  "defs",
  "use",
  "image",
] as const

export function summarizeSvg(svg: string): string {
  const parts: string[] = []
  for (const tag of COUNTED) {
    const re = new RegExp(`<\\s*${tag}\\b`, "gi")
    const n = svg.match(re)?.length ?? 0
    if (n > 0) parts.push(`${n} <${tag}>`)
  }
  const root = /<\s*svg\b([^>]*)>/i.exec(svg)?.[1] ?? ""
  const attr = (name: string): string | undefined => {
    const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(root)
    return m?.[1]
  }
  const viewBox = attr("viewBox")
  const width = attr("width")
  const height = attr("height")
  const dims =
    viewBox !== undefined
      ? `viewBox ${viewBox}`
      : width !== undefined || height !== undefined
        ? `${width ?? "?"}x${height ?? "?"}`
        : undefined
  const head = parts.length > 0 ? parts.join(", ") : "empty svg"
  const tail = [dims, `${svg.length} bytes`].filter((s) => s !== undefined).join(", ")
  const summary = tail.length > 0 ? `${head}, ${tail}` : head
  return summary.length > 300 ? summary.slice(0, 297) + "…" : summary
}
