import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_EDITOR_MODE, readEditorMode, writeEditorMode } from "./notesPrefs";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("editor mode preference (UX-06)", () => {
  it("falls back to the default when nothing, or something unknown, is stored", () => {
    expect(readEditorMode()).toBe(DEFAULT_EDITOR_MODE);
    localStorage.setItem("atlas-notes-mode", "wysiwyg");
    expect(readEditorMode()).toBe(DEFAULT_EDITOR_MODE);
  });

  it("remembers the last choice, including a deliberate Source", () => {
    writeEditorMode("source");
    expect(readEditorMode()).toBe("source");
    writeEditorMode("live");
    expect(readEditorMode()).toBe("live");
    writeEditorMode("source");
    expect(readEditorMode()).toBe("source");
  });

  it("works when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeEditorMode("live")).not.toThrow();
    expect(readEditorMode()).toBe(DEFAULT_EDITOR_MODE);
  });
});
