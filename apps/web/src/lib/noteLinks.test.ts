import type { NoteSummary } from "../api/client";
import { taskTitleFromText, wikiCompletions, wikiTarget } from "./noteLinks";

const note = (path: string, title = path): NoteSummary => ({
  id: path,
  path,
  title,
  revision: 1,
  content_hash: "h",
  size_bytes: 1,
});

describe("taskTitleFromText", () => {
  it.each([
    ["Call Sam", "Call Sam"],
    ["  - [ ] Call Sam  ", "Call Sam"],
    ["* [x] Done thing", "Done thing"],
    ["12. Numbered item", "Numbered item"],
    ["## Heading text", "Heading text"],
    ["> - [ ] Quoted todo", "Quoted todo"],
    ["\n\n  First real line\nsecond line", "First real line"],
    ["", ""],
    ["- [ ]", ""],
  ])("%j becomes %j", (text, expected) => {
    expect(taskTitleFromText(text)).toBe(expected);
  });
});

describe("wiki link completion", () => {
  const notes = [
    note("Projects/Atlas plan.md", "Atlas plan"),
    note("Inbox/Atlas ideas.md", "Ideas"),
    note("Daily/2026-11-02.md", "Today"),
    note("Weird [name].md"),
    note("Pipe|name.md"),
  ];

  it.each([
    ["Plan.md", "Plan"],
    ["a/b.MD", "a/b"],
    ["Weird [name].md", null],
    ["Pipe|name.md", null],
    ["Heading#1.md", null],
  ])("target for %j is %j", (path, expected) => {
    expect(wikiTarget({ path })).toBe(expected);
  });

  it.each([
    ["", ["Daily/2026-11-02", "Inbox/Atlas ideas", "Projects/Atlas plan"]],
    ["atlas", ["Inbox/Atlas ideas", "Projects/Atlas plan"]],
    ["atlas pl", ["Projects/Atlas plan"]],
    ["ideas", ["Inbox/Atlas ideas"]], // matches the title as well as the path
    ["inbox/", ["Inbox/Atlas ideas"]],
    ["zzz", []],
  ])("typed %j offers %j (unsafe paths never offered)", (typed, expected) => {
    expect(wikiCompletions(notes, typed).map((c) => c.target)).toEqual(expected);
  });

  it("is bounded", () => {
    const many = Array.from({ length: 50 }, (_, i) => note(`n${i}.md`));
    expect(wikiCompletions(many, "")).toHaveLength(20);
  });
});
