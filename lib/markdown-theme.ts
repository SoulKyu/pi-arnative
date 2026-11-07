/**
 * Arnative markdown theme — the single override layer for pi's MarkdownTheme.
 *
 * One patch site (InteractiveMode.getMarkdownThemeWithSettings, see
 * extensions/ui-render-tweaks.ts) covers streaming, history and every component that
 * asks the mode for its theme; extensions/tools.ts wraps its own getMarkdownTheme()
 * call with the same layer so tool detail stays consistent.
 *
 * What the layer changes (all stateless — the theme functions get no width and no
 * open/close context, so every override must be decidable from the text alone):
 * - code blocks: both fences become a fixed rule with the language inline
 *   (`─ ts ─────`) — the tool-box grammar. The content keeps pi's own indent: a
 *   per-line `│ ` rail is a rendered cell, and copying code is the block's #1 use
 *   (the fence rules sit on their own lines, so an inside selection stays clean).
 * - quotes: the `│ ` bar becomes a heavier `▌ ` (the palette gives it the accent tier).
 * - lists: `+`/`-`/`*` bullets become `• ` (same 2 columns, continuation lines stay
 *   aligned — pi pads them to the ORIGINAL marker's width).
 * - headings: H3+ `### ` prefixes become `▸ ` (they arrive bold-wrapped, so the match
 *   runs on the stripped text).
 * - ```diff fences: `+`/`-`/`@@` lines get the toolDiff* tokens, like the edit box.
 */
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { stripAnsi } from "./ansi.ts";
import { assert, isMain } from "./check.ts";

export type Painter = { fg(color: string, text: string): string };

/** Total width of a code fence rule; long language labels grow it. */
const RULE_WIDTH = 10;

/**
 * One fence line, stateless: "```ts" → `─ ts ─────`, a bare "```" (closing fence, or an
 * opening fence without a language) → `──────────`. Top and bottom share the shape, so
 * a no-language block still reads as framed.
 */
export function codeBlockRule(text: string): string {
	if (!text.startsWith("```")) return text;
	const lang = text.slice(3).trim();
	const head = lang ? `─ ${lang} ` : "";
	return head + "─".repeat(Math.max(2, RULE_WIDTH - head.length));
}

/** Quote bar: `│ ` → `▌ ` (heavier, same 2 columns). */
export function quoteBar(text: string): string {
	return text === "│ " ? "▌ " : text;
}

/** List bullet: `- `/`+ `/`* ` → `• `. Same width, so wrapped list items stay aligned. */
export function bulletOf(text: string): string {
	return /^[-+*] $/.test(text) ? "• " : text;
}

/** Heading prefix: a bold-wrapped `### ` → `▸ ` (H1/H2 pass through). */
export function headingMark(text: string): string {
	return /^#{3,6} $/.test(stripAnsi(text)) ? text.replace(/#{3,6} /, "▸ ") : text;
}

/** ```diff fence lines in the toolDiff* tokens — the same ones the edit box uses. */
export function diffBlock(code: string, th: Painter): string[] {
	return code.split("\n").map((l) => {
		if (l.startsWith("+") && !l.startsWith("+++")) return th.fg("toolDiffAdded", l);
		if (l.startsWith("-") && !l.startsWith("---")) return th.fg("toolDiffRemoved", l);
		if (l.startsWith("@@")) return th.fg("accent", l);
		return th.fg("toolDiffContext", l);
	});
}

/**
 * The arnative layer over any base theme. `th` only feeds the diff painter; when it is
 * null (before session_start) diff fences keep the base highlighting.
 */
export function arnativeMarkdownTheme(base: MarkdownTheme, th: Painter | null): MarkdownTheme {
	return {
		...base,
		codeBlockBorder: (text) => base.codeBlockBorder(codeBlockRule(text)),
		// No codeBlockIndent override: pi's own setting (default "  ") stays — the rail
		// idea was dropped because a copied block must paste clean.
		quoteBorder: (text) => base.quoteBorder(quoteBar(text)),
		listBullet: (text) => base.listBullet(bulletOf(text)),
		heading: (text) => base.heading(headingMark(text)),
		highlightCode: base.highlightCode
			? (code: string, lang?: string) =>
				th && /^(diff|patch)$/i.test(lang ?? "") ? diffBlock(code, th) : base.highlightCode!(code, lang)
			: undefined,
	};
}

/**
 * H1/H2 banners for assistant messages: a dim `---` rule lands under the heading, so
 * section starts read as banners (the theme's `hr` painter colors it mdHr).
 *
 * - Code fences are skipped (`# comment` inside a block must not gain a rule).
 * - While streaming, a heading on the LAST line is left alone: it may still grow, and
 *   a rule that appears and reflows every frame reads as flicker.
 */
export function bannerHeadings(markdown: string, isStreaming: boolean): string {
	const lines = markdown.split("\n");
	let inFence = false;
	const last = lines.length - 1;
	return lines
		.map((line, i) => {
			if (/^\s*```/.test(line)) {
				inFence = !inFence;
				return line;
			}
			if (inFence || !/^#{1,2} \S/.test(line)) return line;
			if (isStreaming && i === last) return line;
			return `${line}\n\n---`;
		})
		.join("\n");
}

// Self-check: `node lib/markdown-theme.ts`
if (isMain(import.meta.url)) {
	// fence rules: labeled top, plain bottom, both the same fixed width
	assert(codeBlockRule("```ts") === "─ ts ─────", "labeled fence: rule with the language inline");
	assert(codeBlockRule("```") === "──────────", "bare fence: plain rule (top and bottom share the shape)");
	assert(codeBlockRule("```typescript") === "─ typescript ──", "a long label grows the rule instead of clipping");
	assert(codeBlockRule("plain") === "plain", "non-fence text passes through");

	assert(quoteBar("│ ") === "▌ ", "quote bar becomes the heavy glyph");
	assert(quoteBar("other") === "other", "non-bar quote borders pass through");

	assert(bulletOf("- ") === "• ", "dash bullet becomes •");
	assert(bulletOf("* ") === "• ", "star bullet becomes •");
	assert(bulletOf("3. ") === "3. ", "ordered markers stay");
	assert(bulletOf("- [x] ") === "- [x] ", "task markers keep their bullet (width must not change)");

	assert(headingMark("### ") === "▸ ", "H3 prefix becomes the glyph");
	assert(headingMark("###### ") === "▸ ", "H6 prefix becomes the glyph");
	assert(headingMark("\x1b[1m### \x1b[22m") === "\x1b[1m▸ \x1b[22m", "bold-wrapped prefix keeps its ANSI");
	assert(headingMark("A heading") === "A heading", "heading text passes through");

	const tag: Painter = { fg: (c, t) => `<${c}>${t}</${c}>` };
	assert(
		JSON.stringify(diffBlock("+ a\n- b\n@@ h\n  c", tag)) ===
			JSON.stringify(["<toolDiffAdded>+ a</toolDiffAdded>", "<toolDiffRemoved>- b</toolDiffRemoved>", "<accent>@@ h</accent>", "<toolDiffContext>  c</toolDiffContext>"]),
		"diff lines map to the toolDiff* tokens",
	);
	assert(
		JSON.stringify(diffBlock("+++ file\n--- file", tag)) ===
			JSON.stringify(["<toolDiffContext>+++ file</toolDiffContext>", "<toolDiffContext>--- file</toolDiffContext>"]),
		"diff file headers stay context",
	);

	// the composed layer: every override delegates its coloring to the base
	const base: MarkdownTheme = {
		heading: (t) => `H(${t})`,
		link: (t) => t,
		linkUrl: (t) => t,
		code: (t) => t,
		codeBlock: (t) => t,
		codeBlockBorder: (t) => `B(${t})`,
		quote: (t) => t,
		quoteBorder: (t) => `Q(${t})`,
		hr: (t) => t,
		listBullet: (t) => `L(${t})`,
		bold: (t) => `**${t}**`,
		italic: (t) => t,
		strikethrough: (t) => t,
		underline: (t) => t,
		highlightCode: (code) => code.split("\n"),
	};
	const layered = arnativeMarkdownTheme(base, tag);
	assert(layered.codeBlockBorder("```ts") === "B(─ ts ─────)", "fence rule colored by the base border painter");
	assert(layered.codeBlockIndent === base.codeBlockIndent, "code indent stays pi's own (copy of a block must paste clean)");
	assert(layered.quoteBorder("│ ") === "Q(▌ )", "quote bar colored by the base quote painter");
	assert(layered.listBullet("- ") === "L(• )", "bullet colored by the base list painter");
	assert(layered.heading("### ") === "H(▸ )", "heading prefix colored by the base heading painter");
	assert(layered.heading("Title") === "H(Title)", "heading text unchanged");
	assert(JSON.stringify(layered.highlightCode!("+ a", "diff")) === JSON.stringify(["<toolDiffAdded>+ a</toolDiffAdded>"]), "diff fences take the semantic painter");
	assert(JSON.stringify(layered.highlightCode!("let x", "ts")) === JSON.stringify(["let x"]), "other languages keep the base highlighting");
	assert(JSON.stringify(arnativeMarkdownTheme(base, null).highlightCode!("+ a", "diff")) === JSON.stringify(["+ a"]), "no theme yet: diff keeps the base");
	const noHighlight = { ...base, highlightCode: undefined };
	assert(arnativeMarkdownTheme(noHighlight, tag).highlightCode === undefined, "a base without highlightCode stays without");

	// banners: rule under H1/H2, fences skipped, streaming tail left alone
	assert(bannerHeadings("# Title\nbody", false) === "# Title\n\n---\nbody", "H1 gains a rule");
	assert(bannerHeadings("## Title\nbody", false) === "## Title\n\n---\nbody", "H2 gains a rule");
	assert(bannerHeadings("### Title\nbody", false) === "### Title\nbody", "H3+ stays inline (the glyph is enough)");
	assert(bannerHeadings("```\n# not a heading\n```", false) === "```\n# not a heading\n```", "fenced lines gain no rule");
	assert(bannerHeadings("# Done\n", true) === "# Done\n\n---\n", "a finished heading gets its rule while streaming");
	assert(bannerHeadings("# Still", true) === "# Still", "a heading on the streaming last line is left alone");
	console.log("lib/markdown-theme.ts OK");
}
