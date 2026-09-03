/**
 * SVG validation & sanitization. Runs before any rasterization.
 *
 * Policy (per PLUGIN.md §4.3): reject the call with a model-correctable
 * message on any violation. Never silently mutate markup — the model must see
 * exactly why its SVG was refused so it can retry.
 */
import { XMLParser, XMLValidator } from "fast-xml-parser"

export class ValidateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ValidateError"
  }
}

export type ValidateOpts = {
  maxSvgBytes: number
  maxPixels: number
  width?: number
  height?: number
}

const MAX_DEPTH = 128
const MAX_USE_PATTERN_ELEMENTS = 500

const SCRIPT_RE = /<\s*script[\s>]/i
const SCRIPT_CLOSE_RE = /<\s*\/\s*script\s*>/i
const FOREIGN_OBJECT_RE = /<\s*foreignObject[\s>]/i
const ON_ATTR_RE = /\bon\w+\s*=/i
const IMPORT_RE = /@import/i
const URL_FN_RE = /url\s*\(/i

function parseLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const m = /^\s*([\d.]+)\s*(px)?\s*$/.exec(value)
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function intrinsicSize(svg: string): { width?: number; height?: number } {
  // Read width/height attributes off the root <svg> tag only.
  const root = /<\s*svg\b([^>]*)>/i.exec(svg)
  if (!root) return {}
  const attrs = root[1]
  const w = /(?:^|\s)width\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]
  const h = /(?:^|\s)height\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]
  return { width: parseLength(w), height: parseLength(h) }
}

/**
 * Validate raw SVG markup. Returns the original string unchanged on success.
 * @throws {ValidateError} with a model-facing message on any violation.
 */
export function validateSvg(svg: string, opts: ValidateOpts): string {
  if (typeof svg !== "string" || svg.trim().length === 0) {
    throw new ValidateError("SVG must be a non-empty string of well-formed <svg> markup.")
  }
  if (svg.length > opts.maxSvgBytes) {
    throw new ValidateError(
      `SVG is ${svg.length} bytes, exceeding the ${opts.maxSvgBytes} byte limit. Simplify the artwork (fewer elements, less precision, no embedded data) and retry.`,
    )
  }

  const trimmed = svg.trim()
  if (!/^<\s*svg[\s>]/i.test(trimmed) && !/^<\?xml[\s>]/.test(trimmed)) {
    throw new ValidateError("SVG must start with an <svg> root element (must be well-formed XML).")
  }

  // Well-formedness via strict XML validation. (The validator does not enforce
  // a nesting limit; the depth guard below is the binding limit.)
  const validation = XMLValidator.validate(trimmed, { allowBooleanAttributes: false })
  if (validation !== true) {
    const err = validation as { err?: { line?: number; col?: number; msg?: string } }
    const line = err?.err?.line ?? "?"
    const msg = err?.err?.msg ?? "malformed XML"
    throw new ValidateError(`SVG parse error at line ${line}: ${msg}. Ensure tags are balanced and quoted.`)
  }

  // Bomb guard: nesting depth runs on raw markup before building a parse
  // tree, so hostile depth fails fast instead of stressing the parser.
  const depth = maxNestingDepth(trimmed)
  if (depth > MAX_DEPTH) {
    throw new ValidateError(
      `SVG nesting depth ${depth} exceeds the limit of ${MAX_DEPTH}. Flatten groups and retry.`,
    )
  }

  // Confirm the document element is <svg> (parse tree root).
  const parser = new XMLParser({
    ignoreAttributes: false,
    allowBooleanAttributes: false,
    maxNestedTags: MAX_DEPTH + 72,
  })
  let doc: unknown
  try {
    doc = parser.parse(trimmed)
  } catch {
    throw new ValidateError("SVG parse error: unable to parse markup as XML.")
  }
  const keys =
    doc !== null && typeof doc === "object" ? Object.keys(doc as Record<string, unknown>) : []
  const rootKey = keys.find((k) => k !== "?xml")
  if (rootKey !== "svg") {
    throw new ValidateError("SVG root element must be <svg> (case-sensitive).")
  }

  // Dangerous content — reject, don't silently strip.
  if (SCRIPT_RE.test(svg) || SCRIPT_CLOSE_RE.test(svg)) {
    throw new ValidateError("SVG must not contain <script> elements. Remove all scripts and retry.")
  }
  if (FOREIGN_OBJECT_RE.test(svg)) {
    throw new ValidateError(
      "SVG must not contain <foreignObject> (embedded HTML cannot be sandboxed). Inline the artwork as vector elements instead.",
    )
  }
  if (ON_ATTR_RE.test(svg)) {
    throw new ValidateError(
      "SVG must not contain event-handler attributes (onclick, onload, onerror, …). Remove all on* attributes and retry.",
    )
  }
  if (IMPORT_RE.test(svg)) {
    throw new ValidateError("SVG must not contain @import. Inline all styles and retry.")
  }

  // External references: http(s), protocol-relative, or non-image data: URLs.
  // Allowed: relative fragment refs (#id), and data:image/* inlines.
  const hrefRe = /(?:href|xlink:href)\s*=\s*["']([^"']*)["']/gi
  let m: RegExpExecArray | null
  while ((m = hrefRe.exec(svg)) !== null) {
    const v = m[1].trim()
    if (v.startsWith("#") || v === "") continue
    if (/^data:image\//i.test(v)) continue
    throw new ValidateError(
      "SVG must be self-contained: external href/xlink:href references are not allowed (found " +
        JSON.stringify(v.slice(0, 80)) +
        "). Inline the resource or remove it.",
    )
  }
  if (URL_FN_RE.test(svg)) {
    // Allow url(#fragment) only; anything else may pull remote resources.
    const urlRe = /url\s*\(\s*["']?([^)"']*)["']?\s*\)/gi
    let u: RegExpExecArray | null
    while ((u = urlRe.exec(svg)) !== null) {
      const v = u[1].trim()
      if (v.startsWith("#")) continue
      throw new ValidateError(
        "SVG must be self-contained: url() references to external resources are not allowed (found " +
          JSON.stringify(v.slice(0, 80)) +
          ").",
      )
    }
  }

  // Bomb guards (continued).
  const useCount = (svg.match(/<\s*(use|pattern)\b/gi) ?? []).length
  if (useCount > MAX_USE_PATTERN_ELEMENTS) {
    throw new ValidateError(
      `SVG contains ${useCount} <use>/<pattern> elements (limit ${MAX_USE_PATTERN_ELEMENTS}). Simplify and retry.`,
    )
  }

  const intrinsic = intrinsicSize(svg)
  const w = opts.width ?? intrinsic.width ?? 1024
  const h = opts.height ?? intrinsic.height ?? 1024
  if (w * h > opts.maxPixels) {
    throw new ValidateError(
      `Requested raster size ${w}x${h} = ${w * h} px exceeds the ${opts.maxPixels} px limit. Reduce width/height and retry.`,
    )
  }

  return svg
}

function maxNestingDepth(svg: string): number {
  // Lightweight tag-stack scan over the raw markup (comments/PIs stripped).
  const stripped = svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<![A-Z][\s\S]*?>/g, "")
  const tagRe = /<\s*(\/?)\s*([A-Za-z][\w:.-]*)([^>]*?)(\/?)\s*>/g
  let depth = 0
  let max = 0
  let t: RegExpExecArray | null
  while ((t = tagRe.exec(stripped)) !== null) {
    const isClose = t[1] === "/"
    const selfClose = t[4] === "/" || /\/\s*$/.test(t[3]) || /\/$/.test(t[0].replace(/>\s*$/, ""))
    // More robust self-close: tag ends with "/>"
    const selfClosing = /\/\s*>$/.test(t[0])
    if (isClose) {
      depth = Math.max(0, depth - 1)
    } else if (!selfClosing && !selfClose) {
      depth += 1
      if (depth > max) max = depth
    } else {
      // Self-closing contributes one level.
      if (depth + 1 > max) max = depth + 1
    }
  }
  return max
}
