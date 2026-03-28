/**
 * Terminal UI — colors, spinners, animations, progress bars.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const isTTY = !!(process.stderr.isTTY && process.stdout.isTTY);

export const c = {
  reset:    isTTY ? "\x1b[0m" : "",
  bold:     isTTY ? "\x1b[1m" : "",
  dim:      isTTY ? "\x1b[2m" : "",
  italic:   isTTY ? "\x1b[3m" : "",
  under:    isTTY ? "\x1b[4m" : "",
  red:      isTTY ? "\x1b[38;5;203m" : "",
  orange:   isTTY ? "\x1b[38;5;208m" : "",
  yellow:   isTTY ? "\x1b[38;5;221m" : "",
  green:    isTTY ? "\x1b[38;5;114m" : "",
  cyan:     isTTY ? "\x1b[38;5;80m" : "",
  blue:     isTTY ? "\x1b[38;5;75m" : "",
  purple:   isTTY ? "\x1b[38;5;141m" : "",
  pink:     isTTY ? "\x1b[38;5;211m" : "",
  gray:     isTTY ? "\x1b[38;5;243m" : "",
  white:    isTTY ? "\x1b[38;5;255m" : "",
  bgRed:    isTTY ? "\x1b[48;5;52m" : "",
  bgGreen:  isTTY ? "\x1b[48;5;22m" : "",
  bgOrange: isTTY ? "\x1b[48;5;94m" : "",
  bgCyan:   isTTY ? "\x1b[48;5;30m" : "",
  hide:     isTTY ? "\x1b[?25l" : "",
  show:     isTTY ? "\x1b[?25h" : "",
  clear:    isTTY ? "\x1b[2K\r" : "",
};

// ---------------------------------------------------------------------------
// Terminal title
// ---------------------------------------------------------------------------

export function setTitle(text: string) {
  if (isTTY) process.stderr.write(`\x1b]2;${text}\x07`);
}

// ---------------------------------------------------------------------------
// Wind trail — the tailwint signature
// ---------------------------------------------------------------------------

const WIND_CHARS = ["~", "\u2248", "\u223C", "\u301C"];
const WIND_WIDTHS = [1, 1, 1, 2]; // 〜 is fullwidth
const WIND_COLORS = [c.cyan, c.blue, c.purple, c.pink, c.cyan, c.blue];

/** Generates a wind trail that fills exactly `cols` terminal columns. */
export function windTrail(cols: number, offset = 0): string {
  const parts: string[] = [];
  let used = 0;
  let i = 0;
  while (used < cols) {
    const charIdx = (i + offset) % WIND_CHARS.length;
    const colorIdx = (i + offset) % WIND_COLORS.length;
    const w = WIND_WIDTHS[charIdx];
    if (used + w > cols) break; // don't overshoot
    parts.push(`${WIND_COLORS[colorIdx]}${WIND_CHARS[charIdx]}${c.reset}`);
    used += w;
    i++;
  }
  // Fill remaining columns with single-width chars
  while (used < cols) {
    const colorIdx = (i + offset) % WIND_COLORS.length;
    parts.push(`${WIND_COLORS[colorIdx]}~${c.reset}`);
    used++;
    i++;
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Spinners & animation primitives
// ---------------------------------------------------------------------------

const BRAILLE_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2807"];

export let tick = 0;

export function advanceTick() { tick++; }

const SPIN_COLORS = [c.cyan, c.blue, c.purple, c.pink, c.purple, c.blue];

export function braille(): string {
  const color = SPIN_COLORS[Math.floor(tick / 2) % SPIN_COLORS.length];
  return `${color}${BRAILLE_FRAMES[tick % BRAILLE_FRAMES.length]}${c.reset}`;
}

export function windWave(): string {
  return windTrail(6, tick % 24);
}

export function dots(): string {
  const n = tick % 4;
  return `${c.dim}${".".repeat(n)}${" ".repeat(3 - n)}${c.reset}`;
}

export function startSpinner(render: () => string, intervalMs = 100): () => void {
  if (!isTTY) return () => {};
  process.stderr.write(c.hide);
  let lastLines = 1;
  const id = setInterval(() => {
    tick++;
    const output = render();
    const lines = output.split("\n").length;
    // Move up and clear previous lines
    let clear = "\x1b[2K\r";
    for (let i = 1; i < lastLines; i++) clear = `\x1b[A\x1b[2K` + clear;
    process.stderr.write(`${clear}${output}`);
    lastLines = lines;
  }, intervalMs);
  return () => {
    clearInterval(id);
    // Move cursor to the first line of the spinner
    for (let i = 1; i < lastLines; i++) process.stderr.write("\x1b[A");
    // Clear from cursor to end of screen (clears all spinner lines)
    process.stderr.write(`\x1b[2K\x1b[J\r${c.show}`);
  };
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

export function progressBar(pct: number, width: number, animate = false): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const gradient = [c.cyan, c.cyan, c.blue, c.blue, c.purple, c.purple, c.pink];
  const chars = Array.from({ length: filled }, (_, i) => {
    const colorIdx = Math.floor((i / width) * gradient.length);
    const shift = animate ? (tick + i) % gradient.length : colorIdx;
    const color = gradient[Math.min(shift, gradient.length - 1)];
    return `${color}\u2501${c.reset}`;
  }).join("");
  const emptyBar = `${c.dim}${"\u2501".repeat(empty)}${c.reset}`;
  return `${c.dim}\u2503${c.reset}${chars}${emptyBar}${c.dim}\u2503${c.reset}`;
}

// ---------------------------------------------------------------------------
// Banner & celebrations
// ---------------------------------------------------------------------------

// Viewport: 56 visible chars (2 indent + 54 content)
const VP = 54;
const WIND_SIDE = Math.floor((VP - 10) / 2); // 22 each side of " tailwint "

export async function banner() {
  console.error("");

  if (isTTY) {
    process.stderr.write(c.hide);
    for (let frame = 0; frame < 8; frame++) {
      const len = Math.min(frame + 2, WIND_SIDE);
      const pad = " ".repeat(WIND_SIDE - len);
      const left = windTrail(len, frame);
      const right = windTrail(len, frame + 6);
      const titleColor = frame < 4 ? c.dim : c.bold;
      process.stderr.write(`${c.clear}  ${pad}${left} ${titleColor}${c.cyan}tailwint${c.reset} ${right}`);
      await sleep(60);
    }
    process.stderr.write(`${c.clear}${c.show}`);
  }

  console.error(`  ${windTrail(WIND_SIDE)} ${c.bold}${c.cyan}tailwint${c.reset} ${windTrail(WIND_SIDE, 6)}`);
  console.error("");
  console.error(`    ${c.dim}tailwind css linter ${c.gray}// powered by the official lsp${c.reset}`);
  console.error("");
}

function celebrationBurst(): string {
  const sparks = ["\u2728", "\u2727", "\u2726", "\u2729", "\u00B7", "\u2728"];
  const colors = [c.cyan, c.blue, c.purple, c.pink, c.yellow, c.green];
  return Array.from({ length: 6 }, (_, i) =>
    `${colors[i % colors.length]}${sparks[i % sparks.length]}${c.reset}`
  ).join(" ");
}

export function rainbowText(text: string): string {
  const colors = [c.cyan, c.blue, c.purple, c.pink, c.orange, c.yellow, c.green];
  return text
    .split("")
    .map((ch, i) => (ch === " " ? ch : `${colors[i % colors.length]}${ch}${c.reset}`))
    .join("");
}

export async function celebrationAnimation() {
  if (!isTTY) return;
  // Center each frame within the 56-col viewport
  const pad = (visible: number) => " ".repeat(Math.floor((56 - visible) / 2));
  process.stderr.write(c.hide);
  const frames = [
    `${pad(5)}${c.dim}. ${c.reset}${c.cyan}\u2728${c.reset}${c.dim} .${c.reset}`,
    `${pad(5)}${c.blue}\u2727${c.reset} ${c.purple}\u2728${c.reset} ${c.pink}\u2727${c.reset}`,
    `${pad(7)}${c.cyan}\u2728${c.reset} ${c.yellow}\u2726${c.reset} ${c.green}\u2728${c.reset} ${c.purple}\u2729${c.reset}`,
    `${pad(11)}${celebrationBurst()}`,
  ];
  for (const frame of frames) {
    process.stderr.write(`${c.clear}${frame}`);
    await sleep(150);
  }
  process.stderr.write(`${c.clear}${c.show}`);
  console.error(`${pad(11)}${celebrationBurst()}\n`);
}

// ---------------------------------------------------------------------------
// Diagnostic & file formatting
// ---------------------------------------------------------------------------

export function fileBadge(rel: string): string {
  const sep = rel.lastIndexOf("/");
  const dir = sep >= 0 ? `${c.dim}${rel.slice(0, sep + 1)}${c.reset}` : "";
  const name = sep >= 0 ? rel.slice(sep + 1) : rel;
  return `${dir}${c.bold}${c.white}${name}${c.reset}`;
}

export function diagLine(d: any): string {
  const line = (d.range?.start?.line ?? 0) + 1;
  const col = (d.range?.start?.character ?? 0) + 1;
  const loc = `${c.dim}${line}:${col}${c.reset}`;

  const isConflict = d.code === "cssConflict";
  const icon = isConflict ? `${c.orange}\u26A1${c.reset}` : `${c.yellow}\u25CB${c.reset}`;
  const tag = isConflict
    ? `${c.bgOrange}${c.bold} conflict ${c.reset}`
    : `${c.yellow}canonical${c.reset}`;

  return `    ${icon} ${loc} ${tag} ${c.white}${d.message}${c.reset}`;
}
