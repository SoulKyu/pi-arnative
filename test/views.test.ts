/**
 * Suite for extensions/views.ts: which transcript component lands in which view, and the
 * render-time filter that shows it. Run with `npm test`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, visibleWidth } from "@earendil-works/pi-tui";
import extension, {
	currentView,
	installViewFilter,
	kindOf,
	nextView,
	setView,
	viewTabs,
	visibleChildren,
	type View,
} from "../extensions/views.ts";
import { stripAnsi } from "../lib/ansi.ts";

/** A real class instance without running pi's constructor (it needs a live theme). */
const bare = <T>(cls: { prototype: T }, props: object = {}): T => Object.assign(Object.create(cls.prototype as object), props);
const assistant = (...types: string[]) => bare(AssistantMessageComponent, { lastMessage: { content: types.map((type) => ({ type })) } });
const row = (text: string) => ({ render: () => [text], invalidate() {} });
const tag = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };

test("a component is a reply, work, a spacer, or neutral", () => {
	assert.equal(kindOf(bare(UserMessageComponent)), "reply");
	assert.equal(kindOf(assistant("thinking", "text")), "reply", "no tool call: the turn's final message");
	assert.equal(kindOf(assistant("text", "toolCall")), "work", "text before a tool call is narration");
	assert.equal(kindOf(bare(AssistantMessageComponent)), "reply", "a message that has not streamed anything yet");
	assert.equal(kindOf(bare(BashExecutionComponent)), "reply", "`!cmd` output answers the user, not the agent");
	assert.equal(kindOf(bare(ToolExecutionComponent)), "work");
	assert.equal(kindOf(bare(CustomMessageComponent)), "work");
	assert.equal(kindOf(new Spacer(1)), "spacer");
	assert.equal(kindOf(row("Error: no model")), "neutral", "an unknown component is never hidden");
});

test("each view keeps its kinds, and a spacer follows the component after it", () => {
	const kinds = { s: "spacer", u: "reply", a: "reply", t: "work", n: "neutral" } as const;
	const show = (view: View, children: string) =>
		visibleChildren([...children], view, (c) => kinds[c[0] as keyof typeof kinds]).join("");
	const transcript = "sutttsnsa";
	assert.equal(show("replies", transcript), "susnsa");
	assert.equal(show("activity", transcript), "tttsn");
	assert.equal(show("all", transcript), transcript);
	assert.equal(show("activity", "sus"), "s", "a trailing spacer has no owner to hide with");
	const all = [new Spacer(1)];
	assert.equal(visibleChildren(all, "all"), all, "`all` hands back the same array, no copy per frame");
});

test("a streaming message moves to activity the moment its tool call arrives", () => {
	const streaming = assistant("text");
	assert.deepEqual(visibleChildren([streaming], "replies"), [streaming]);
	(streaming as unknown as { lastMessage: object }).lastMessage = { content: [{ type: "text" }, { type: "toolCall" }] };
	assert.deepEqual(visibleChildren([streaming], "replies"), []);
	assert.deepEqual(visibleChildren([streaming], "activity"), [streaming]);
});

test("the filter paints one view and leaves the transcript itself untouched", () => {
	const chat = new Container();
	const tool = bare(ToolExecutionComponent, { render: () => ["tool"] });
	const user = bare(UserMessageComponent, { render: () => ["prompt"] });
	chat.addChild(user);
	chat.addChild(tool);
	chat.addChild(row("status"));
	const children = chat.children;
	let view: View = "replies";
	installViewFilter(chat, () => view);
	assert.deepEqual(chat.render(80), ["prompt", "status"]);
	assert.equal(chat.children, children, "pi's own loops still see every child");
	view = "activity";
	assert.deepEqual(chat.render(80), ["tool", "status"]);
	view = "all";
	assert.deepEqual(chat.render(80), ["prompt", "tool", "status"]);

	// A reload installs the filter again: it replaces the previous one instead of stacking.
	view = "replies";
	installViewFilter(chat, () => view);
	assert.deepEqual(chat.render(80), ["prompt", "status"]);

	// A click lands on the component that is painted on that row, not on a hidden one.
	let clicked = "";
	Object.assign(user, { handleMouse: () => void (clicked = "prompt") });
	Object.assign(tool, { handleMouse: () => void (clicked = "tool") });
	view = "activity";
	chat.render(80);
	chat.handleMouse({ type: "click", x: 0, y: 0, width: 80, height: 2 } as never);
	assert.equal(clicked, "tool");

	// A child that empties the transcript mid-render keeps its change.
	chat.addChild({ render: () => (chat.clear(), ["bye"]), invalidate() {} });
	view = "replies";
	chat.render(80);
	assert.deepEqual(chat.children, [], "the restore never resurrects a cleared transcript");
});

test("the tab row names the three views, marks the active one, and fits the width", () => {
	const line = viewTabs(tag, "activity", 200); // the fake tags are visible columns
	assert.match(line, /<dim>Replies<\/dim>.*<accent>● Activity<\/accent>.*<dim>All<\/dim>/);
	assert.match(line, /\[Ctrl\+(alt|option)\+w\]|\[Alt\+w\]/, `the key is advertised, got ${line}`);
	assert.ok(visibleWidth(stripAnsi(viewTabs({ fg: (_c, text) => text }, "all", 12))) <= 12, "a narrow terminal truncates");
});

test("the key cycles replies → activity → all, in fullscreen only", () => {
	assert.deepEqual([nextView("replies"), nextView("activity"), nextView("all")], ["activity", "all", "replies"]);

	const shortcuts = new Map<string, { handler(ctx: unknown): void }>();
	extension({ on() {}, registerShortcut: (key: string, options: never) => shortcuts.set(key, options) } as never);
	assert.ok(shortcuts.has("ctrl+alt+w"), `registered keys: ${[...shortcuts.keys()]}`);

	// No fullscreen renderer behind this ctx: the key says so and hides nothing.
	const notices: string[] = [];
	const before = currentView();
	shortcuts.get("ctrl+alt+w")!.handler({ ui: { setStatus() {}, setWidget() {}, notify: (message: string) => notices.push(message) } });
	assert.equal(currentView(), before);
	assert.match(notices[0] ?? "", /fullscreen/);

	setView("all");
	assert.equal(currentView(), "all", "the view outlives the module (globalThis), so /reload keeps it");
	setView(before);
});
