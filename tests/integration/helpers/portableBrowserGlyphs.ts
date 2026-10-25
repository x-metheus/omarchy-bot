/**
 * Portable-browser conformance helpers: a local probe page whose glyph cells are
 * found in a real Screen capture, so a missing CJK font shows up as tofu instead
 * of a passing assertion. Analysis reads pixels only; no headless browser.
 */
import sharp from "../../../apps/daemon/node_modules/sharp";

export const PORTABLE_BROWSER_ENV = "OMARCHY_BOT_REAL_PORTABLE_BROWSER";
export const GLYPH_CELL = 96;
/** Pure magenta is absent from Chromium chrome and Sway backgrounds, so the page is found by color. */
export const PROBE_BACKGROUND = [255, 0, 255] as const;
/**
 * Calibrated against Chromium 1234 at 72px: a real CJK glyph inks 1269–1512 pixels,
 * and the tofu box a font without the codepoint paints inks 504. Latin-only or empty
 * font configs ink 0 or 504, and every missing glyph is the same box, so requiring
 * ink above 800 and a shape distance above 0.3 from that box separates them.
 */
const INK_LUMINANCE = 60;

export interface GlyphCell {
  id: string;
  character: string;
  x: number;
  y: number;
}

/** One row of glyphs. The last cell is a noncharacter: absent from every supplied font. */
export const GLYPH_CELLS: readonly GlyphCell[] = [
  { id: "latin", character: "W", x: 4, y: 4 },
  { id: "zh", character: "你", x: 100, y: 4 },
  { id: "ja", character: "あ", x: 196, y: 4 },
  { id: "ko", character: "한", x: 292, y: 4 },
  { id: "tofu", character: "\uFFFF", x: 388, y: 4 },
];

/**
 * The probe page: glyph row plus a localStorage counter, so a second window that
 * reports a higher count proves the windows share one browser profile.
 */
export function glyphProbeHtml(): string {
  const cells = GLYPH_CELLS
    .map((cell) => `<span style="left:${cell.x}px;top:${cell.y}px">${cell.character}</span>`)
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>glyph probe</title>
<style>
html,body{margin:0;height:100%;overflow:hidden;background:rgb(${PROBE_BACKGROUND.join(",")})}
span{position:absolute;width:${GLYPH_CELL}px;height:${GLYPH_CELL}px;font:72px/${GLYPH_CELL}px sans-serif;
color:#000;text-align:center;white-space:nowrap}
</style>${cells}
<script>
const label = new URLSearchParams(location.search).get("label") ?? "probe";
const count = Number(localStorage.getItem("probe-count") ?? "0") + 1;
localStorage.setItem("probe-count", String(count));
document.title = label + " count:" + count;
</script>`;
}

export interface GlyphMask {
  id: string;
  width: number;
  height: number;
  /** 1 = dark text pixel, one byte per pixel. */
  ink: Uint8Array;
  count: number;
}

export interface GlyphProbe {
  cells: GlyphMask[];
  bounds: { x: number; y: number; width: number; height: number };
}

/** Reads the probe page's glyph row out of a full-output Screen capture. */
export async function readGlyphProbe(png: Uint8Array): Promise<GlyphProbe> {
  const { data, info } = await sharp(Buffer.from(png))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      if (
        Math.abs(data[offset]! - PROBE_BACKGROUND[0]) <= 6
        && Math.abs(data[offset + 1]! - PROBE_BACKGROUND[1]) <= 6
        && Math.abs(data[offset + 2]! - PROBE_BACKGROUND[2]) <= 6
      ) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || maxY < 0) {
    throw new Error(`probe page background rgb(${PROBE_BACKGROUND.join(",")}) is not visible in the capture`);
  }
  const bounds = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  const cells = GLYPH_CELLS.map((cell): GlyphMask => {
    const ink = new Uint8Array(GLYPH_CELL * GLYPH_CELL);
    let count = 0;
    for (let y = 0; y < GLYPH_CELL; y += 1) {
      for (let x = 0; x < GLYPH_CELL; x += 1) {
        const sourceX = bounds.x + cell.x + x;
        const sourceY = bounds.y + cell.y + y;
        if (sourceX >= width || sourceY >= height) continue;
        const offset = (sourceY * width + sourceX) * channels;
        const luminance = 0.299 * data[offset]! + 0.587 * data[offset + 1]! + 0.114 * data[offset + 2]!;
        if (luminance < INK_LUMINANCE) {
          ink[y * GLYPH_CELL + x] = 1;
          count += 1;
        }
      }
    }
    return { id: cell.id, width: GLYPH_CELL, height: GLYPH_CELL, ink, count };
  });
  return { cells, bounds };
}

/** Share of differing ink pixels relative to the denser mask; 0 = identical shapes. */
export function maskDistance(a: GlyphMask, b: GlyphMask): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error("glyph masks must have the same size");
  let differing = 0;
  for (let index = 0; index < a.ink.length; index += 1) {
    if ((a.ink[index] === 1) !== (b.ink[index] === 1)) differing += 1;
  }
  return differing / Math.max(1, a.count, b.count);
}
