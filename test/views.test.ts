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
import { homedir } from "node:os";
import extension, {
	currentStep,
	currentView,
	installViewFilter,
	kindOf,
	nextView,
	setView,
	stepLabel,
	viewRows,
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

test("a step is named by its tool and the argument a reader recognises", () => {
	assert.equal(stepLabel("bash", { command: "npm  test\n--watch" }), "bash · npm test --watch", "whitespace folds to one line");
	assert.equal(stepLabel("read", { path: `${homedir()}/repo/a.ts`, limit: 10 }), "read · ~/repo/a.ts", "home shortens to ~");
	assert.equal(stepLabel("subagent", { task: "review the diff", agent: "monitoring-sre" }), "subagent · monitoring-sre", "the agent names the step, not its prompt");
	assert.equal(stepLabel("web_search", { queries: ["pi tui widgets", "second"] }), "web_search · pi tui widgets", "the first of several queries");
	assert.equal(stepLabel("todo", { action: "update", id: 3, status: "completed" }), "todo · update", "no known key: the first string argument");
	assert.equal(stepLabel("ls", {}), "ls");
	assert.equal(stepLabel("ls", undefined), "ls", "a tool called without arguments");
	assert.ok(stepLabel("bash", { command: "x".repeat(5000) }).length < 300, "a huge argument is cut before it is ever painted");
});

test("Replies shows the running step under the tabs; the other views already show the work", () => {
	const step = { count: 12, label: "bash · npm test" };
	const rows = viewRows(tag, "replies", step, 200);
	assert.equal(rows.length, 2);
	assert.match(rows[0]!, /● Replies/);
	assert.match(rows[1]!, /<dim>↳ step 12 ·<\/dim> <muted>bash · npm test<\/muted>/);
	assert.equal(viewRows(tag, "replies", undefined, 200).length, 1, "an idle agent adds no row");
	assert.equal(viewRows(tag, "activity", step, 200).length, 1);
	assert.equal(viewRows(tag, "all", step, 200).length, 1);
	const narrow = viewRows({ fg: (_c, text) => text }, "replies", { count: 1, label: "bash · " + "y".repeat(200) }, 30)[1]!;
	assert.ok(visibleWidth(stripAnsi(narrow)) <= 30 && narrow.includes("…"), "a long step is cut with an ellipsis");
});

test("each tool start is a step, and the count runs until the agent settles", async () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	extension({ on: (event: string, handler: never) => handlers.set(event, handler), registerShortcut() {} } as never);
	assert.equal(currentStep(), undefined);
	await handlers.get("tool_execution_start")!({ toolName: "read", args: { path: "a.ts" } }, {});
	await handlers.get("tool_execution_start")!({ toolName: "bash", args: { command: "npm test" } }, {});
	assert.deepEqual(currentStep(), { count: 2, label: "bash · npm test" });
	await handlers.get("agent_settled")!({ aborted: false }, {});
	assert.equal(currentStep(), undefined, "a settled agent is working on nothing");
	await handlers.get("tool_execution_start")!({ toolName: "ls", args: {} }, {});
	assert.deepEqual(currentStep(), { count: 1, label: "ls" }, "the next prompt counts from one");
	await handlers.get("agent_settled")!({ aborted: true }, {});
});
