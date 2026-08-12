import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React, { useState } from "react";
import { SongSectionEditorList } from "../SongSectionEditor";
import { SongArrangementEditor } from "../SongArrangementEditor";
import type { Song, LyricSection, SongArrangementStep } from "../../../types";

/** Stateful wrapper so the controlled arrangement editor sees the updated
 *  draft after each onChange (mirrors how SongEditorModal feeds it). */
function ArrangementHarness({ initial }: { initial: Song }) {
  const [draft, setDraft] = useState<Song>(() => JSON.parse(JSON.stringify(initial)));
  const spy = vi.fn();
  return (
    <>
      <SongArrangementEditor
        draft={draft}
        onChange={(steps: SongArrangementStep[]) => {
          spy(steps);
          setDraft((d) => ({ ...d, arrangement_steps: steps }));
        }}
      />
      <div data-testid="steps">{JSON.stringify(draft.arrangement_steps ?? [])}</div>
    </>
  );
}

function stepsOf(container: HTMLElement): SongArrangementStep[] {
  return JSON.parse((container.querySelector('[data-testid="steps"]') as HTMLElement).textContent || "[]");
}

const section = (id: string, label: string, lines: string[]): LyricSection => ({ id, label, lines });

describe("SongSectionEditorList", () => {
  it("splits a multiline textarea into lines preserving order", () => {
    const onChange = vi.fn();
    render(
      <SongSectionEditorList
        sections={[section("a", "Verse", ["old"])]}
        onChange={onChange}
      />,
    );
    const ta = screen.getByPlaceholderText("One lyric line per row") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "first\nsecond\nthird" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as LyricSection[];
    expect(next[0].lines).toEqual(["first", "second", "third"]);
  });

  it("keeps section ids stable after a lyrics edit", () => {
    const onChange = vi.fn();
    render(
      <SongSectionEditorList
        sections={[section("keep-id", "Verse", ["x"])]}
        onChange={onChange}
      />,
    );
    const ta = screen.getByPlaceholderText("One lyric line per row") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "new line\nsecond line" } });
    const next = onChange.mock.calls[0][0] as LyricSection[];
    expect(next[0].id).toBe("keep-id");
    expect(next[0].lines).toEqual(["new line", "second line"]);
  });

  it("trims trailing blank lines on textarea conversion", () => {
    const onChange = vi.fn();
    render(
      <SongSectionEditorList
        sections={[section("a", "Verse", ["x"])]}
        onChange={onChange}
      />,
    );
    const ta = screen.getByPlaceholderText("One lyric line per row") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "keep\n  \n\n" } });
    expect((onChange.mock.calls[0][0] as LyricSection[])[0].lines).toEqual(["keep"]);
  });

  it("duplicates a section as a new section without copying the id", () => {
    const onChange = vi.fn();
    render(
      <SongSectionEditorList
        sections={[section("orig", "Chorus", ["line"])]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText("Duplicate section"));
    const next = onChange.mock.calls[0][0] as LyricSection[];
    expect(next).toHaveLength(2);
    expect(next[0].id).toBe("orig");
    expect(next[1].id).toBeUndefined();
    expect(next[1].lines).toEqual(["line"]);
  });

  it("reorders source sections without touching arrangement steps (editor-only)", () => {
    const onChange = vi.fn();
    render(
      <SongSectionEditorList
        sections={[section("a", "Verse", ["1"]), section("b", "Chorus", ["2"])]}
        onChange={onChange}
      />,
    );
    // The first section's "move down" swaps it with the chorus.
    const rows = screen.getAllByRole("button", { name: "Move section down" });
    fireEvent.click(rows[0]);
    const next = onChange.mock.calls[0][0] as LyricSection[];
    expect(next.map((s) => s.id)).toEqual(["b", "a"]);
  });
});

describe("SongArrangementEditor", () => {
  const song = (sections: LyricSection[], arrangement_steps?: Song["arrangement_steps"]): Song =>
    ({
      id: "s1",
      title: "T",
      sections,
      arrangement_steps,
    } as Song);

  it("repeats a chorus as two steps referencing the same id (no lyric duplication)", () => {
    const initial = song([section("c", "Chorus", ["line"])]);
    const { container } = render(<ArrangementHarness initial={initial} />);
    const addChorus = screen.getAllByRole("button", { name: /Chorus/ })[0];
    fireEvent.click(addChorus);
    fireEvent.click(addChorus);
    expect(stepsOf(container)).toEqual([{ section_id: "c" }, { section_id: "c" }]);
  });

  it("reset builds natural-order steps from the current sections", () => {
    const initial = song([section("a", "Verse", ["1"]), section("b", "Chorus", ["2"])], []);
    const { container } = render(<ArrangementHarness initial={initial} />);
    fireEvent.click(screen.getByLabelText("Reset to natural order"));
    expect(stepsOf(container)).toEqual([{ section_id: "a" }, { section_id: "b" }]);
  });

  it("reordering steps changes playback order only", () => {
    const initial = song(
      [section("a", "Verse", ["1"]), section("b", "Chorus", ["2"])],
      [{ section_id: "a" }, { section_id: "b" }],
    );
    const { container } = render(<ArrangementHarness initial={initial} />);
    fireEvent.click(screen.getAllByLabelText("Move step up")[1]);
    expect(stepsOf(container)).toEqual([{ section_id: "b" }, { section_id: "a" }]);
  });

  it("clear empties the arrangement", () => {
    const initial = song(
      [section("a", "Verse", ["1"])],
      [{ section_id: "a" }],
    );
    const { container } = render(<ArrangementHarness initial={initial} />);
    fireEvent.click(screen.getByLabelText("Clear arrangement"));
    expect(stepsOf(container)).toEqual([]);
  });
});