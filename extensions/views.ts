/**
 * Transcript views: one key cycles what the fullscreen transcript paints.
 * - Replies (default): your prompts and the message that ends each turn.
 * - Activity: the work behind them — tool boxes, narration between tool calls, custom
 *   messages (subagents, reviews), compaction and branch summaries.
 * - All: pi's transcript, unfiltered.
 * Status lines, errors and anything unknown stay in every view: nothing is hidden unless it
 * is known to be the other view's content.
 *
 * Render layer only. The filter swaps `chatContainer.children` for the duration of one
 * `render`/`handleMouse` call, so pi's own code (session rebuild, expand/collapse, status
 * coalescing) keeps seeing every component, and search, selection and prompt jumps work on
 * the lines that are painted. Regular mode is left alone: the terminal owns that scrollback.
 */
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	InteractiveMode,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Spacer, truncateToWidth, TuiAltScreen } from "@earendil-works/pi-tui";
import { patchOnce } from "../lib/patch.ts";
import { SHORTCUT_CYCLE_VIEW } from "../lib/shortcuts.ts";

export const VIEWS = ["replies", "activity", "all"] as const;
export type View = (typeof VIEWS)[number];
const LABELS: Record<View, string> = { replies: "Replies", activity: "Activity", all: "All" };

// On globalThis: `/reload` re-evaluates this module, and the view must not snap back.
const VIEW_KEY = Symbol.for("pi-arnative.transcriptView");
const store = globalThis as Record<symbol, View | undefined>;
export const currentView = (): View => store[VIEW_KEY] ?? "replies";
export const setView = (view: View): void => void (store[VIEW_KEY] = view);
export const nextView = (view: View): View => VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]!;

export type Kind = "reply" | "work" | "spacer" | "neutral";
/** `!cmd` output is a reply: the user ran it, and hiding what they just asked for is a trap. */
const REPLY = [UserMessageComponent, SkillInvocationMessageComponent, BashExecutionComponent];
const WORK = [ToolExecutionComponent, CustomMessageComponent, CompactionSummaryMessageComponent, BranchSummaryMessageComponent];

export function kindOf(child: unknown): Kind {
	if (child instanceof Spacer) return "spacer";
	if (child instanceof AssistantMessageComponent) {
		// Same test as the role gutter (extensions/timestamps.ts): no tool call = the turn's last
		// message. Read per frame, so a streaming message changes side when its tool call arrives.
		const content = (child as unknown as { lastMessage?: { content?: Array<{ type: string }> } }).lastMessage?.content;
		return content?.some((block) => block.type === "toolCall") ? "work" : "reply";
	}
	if (REPLY.some((cls) => child instanceof cls)) return "reply";
	if (WORK.some((cls) => child instanceof cls)) return "work";
	return "neutral";
}

/** The children `view` paints. pi puts a Spacer BEFORE the component it separates, so a
 *  spacer shares the fate of the next component. */
export function visibleChildren<T>(children: T[], view: View, kind: (child: T) => Kind = kindOf): T[] {
	if (view === "all") return children;
	const hidden: Kind = view === "replies" ? "work" : "reply";
	const shown: T[] = [];
	let keep = true;
	for (let i = children.length - 1; i >= 0; i--) {
		const k = kind(children[i]!);
		if (k !== "spacer") keep = k !== hidden;
		if (keep) shown.push(children[i]!);
	}
	return shown.reverse();
}

type Chat = { children: unknown[]; render(width: number): string[]; handleMouse?(event: never): unknown };

/**
 * Paint `view()` instead of the whole transcript. Set on the instance and delegating to the
 * prototype, never to a captured original: installing it again (every `/reload`) replaces the
 * previous filter instead of stacking on it.
 */
export function installViewFilter(chat: Chat, view: () => View): void {
	const proto = Object.getPrototypeOf(chat) as Record<string, (this: Chat, arg: never) => unknown>;
	const filtered = (key: "render" | "handleMouse") =>
		function (this: Chat, arg: never): unknown {
			const all = this.children;
			const shown = visibleChildren(all, view());
			this.children = shown;
			try {
				return proto[key]!.call(this, arg);
			} finally {
				// Only undo our own swap: a child that cleared the transcript keeps its change.
				if (this.children === shown) this.children = all;
			}
		};
	chat.render = filtered("render") as Chat["render"];
	chat.handleMouse = filtered("handleMouse");
}

type FgTheme = { fg(color: string, text: string): string };

/** The row above the editor: every view, the painted one marked, and the key that cycles. */
export function viewTabs(th: FgTheme, view: View, width: number): string {
	const tabs = VIEWS.map((v) => (v === view ? th.fg("accent", `● ${LABELS[v]}`) : th.fg("dim", LABELS[v])));
	return truncateToWidth(` ${tabs.join(th.fg("dim", " · "))}${th.fg("dim", `  [${SHORTCUT_CYCLE_VIEW.label}]`)}`, width, "");
}

type Mode = {
	chatContainer?: Chat;
	ui?: { requestRender(): void };
	transcriptScrollView?: { scrollToEnd(): void };
};
let mode: Mode | undefined;
const STATUS_KEY = "arnative-views";
// The extension API hands out no InteractiveMode. `ctx.ui.setStatus` runs this method on it,
// so clearing a status key we never set (see `attach`) is how the mode reaches this module.
if (InteractiveMode?.prototype) {
	patchOnce(InteractiveMode.prototype as never, "setExtensionStatus", (orig) => function (this: Mode, ...args: unknown[]) {
		mode = this;
		return orig.apply(this, args);
	});
}

const isFullscreen = (): boolean => mode?.ui instanceof TuiAltScreen;

function attach(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	if (mode?.chatContainer) installViewFilter(mode.chatContainer, () => (isFullscreen() ? currentView() : "all"));
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		attach(ctx);
		// Always on screen in fullscreen: a filtered transcript with no sign of it reads as lost output.
		ctx.ui.setWidget("arnative-views", (_tui, theme) => ({
			render: (width: number) => (isFullscreen() ? [viewTabs(theme, currentView(), width)] : []),
			invalidate() {},
		}));
	});

	const cycle = (ctx: ExtensionContext) => {
		attach(ctx);
		if (!isFullscreen()) {
			ctx.ui.notify("Transcript views need fullscreen mode (tuiMode: fullscreen)", "info");
			return;
		}
		setView(nextView(currentView()));
		// Selection coordinates and the scroll offset both point into the view being replaced.
		(mode!.ui as unknown as TuiAltScreen).resetTextSelection();
		mode!.transcriptScrollView?.scrollToEnd();
		mode!.ui!.requestRender();
	};
	for (const key of SHORTCUT_CYCLE_VIEW.keys) {
		pi.registerShortcut(key, { description: "Cycle transcript view (Replies, Activity, All)", handler: cycle });
	}
}
