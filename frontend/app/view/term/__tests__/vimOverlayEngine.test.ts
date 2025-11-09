import { describe, expect, it } from "vitest";

import { processVimKey, VimBufferState } from "../vimOverlayEngine";

type KeySeq = Array<{ key: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean }>;

function runSequence(initial: { value: string; cursor: number; selectionEnd?: number }, keys: KeySeq) {
    let state: VimBufferState = {
        value: initial.value,
        mode: "insert",
        pendingOperator: null,
        register: null,
        visualAnchor: null,
        visualSelection: null,
    };
    let cursor = initial.cursor;
    let selectionEnd = initial.selectionEnd ?? initial.cursor;

    const positions: Array<{
        value: string;
        cursor: number;
        selectionEnd: number;
        mode: "insert" | "normal" | "visualLine";
    }> = [];

    for (const key of keys) {
        const result = processVimKey(state, cursor, selectionEnd, key);
        if (!result.handled) {
            continue;
        }
        state = result.state;
        cursor = result.cursor;
        selectionEnd = result.selectionEnd;
        positions.push({ value: state.value, cursor, selectionEnd, mode: state.mode });
        if (result.action === "submit" || result.action === "cancel") {
            break;
        }
    }

    return {
        state,
        cursor,
        selectionEnd,
        history: positions,
    };
}

describe("Vim overlay engine", () => {
    it("duplicates first line via Esc, y, y, p", () => {
        const result = runSequence({ value: "line1\nline2\nline3", cursor: 2 }, [
            { key: "Escape" },
            { key: "y" },
            { key: "y" },
            { key: "p" },
        ]);

        expect(result.state.value).toBe("line1\nline1\nline2\nline3");
        expect(result.state.mode).toBe("normal");
        expect(result.cursor).toBe("line1\n".length);
        expect(result.state.register).toMatchObject({ text: "line1\n", kind: "line" });
    });

    it("handles Ctrl+Enter to insert newline in insert mode", () => {
        const result = runSequence({ value: "echo start", cursor: 10 }, [{ key: "Enter", ctrlKey: true }]);
        expect(result.state.value).toBe("echo start\n");
        expect(result.state.mode).toBe("insert");
        expect(result.cursor).toBe(11);
    });

    it("jumps to buffer start with gg", () => {
        const result = runSequence({ value: "line1\nline2\nline3", cursor: "line1\nline".length }, [
            { key: "Escape" },
            { key: "g" },
            { key: "g" },
        ]);
        expect(result.state.mode).toBe("normal");
        expect(result.cursor).toBe(0);
    });

    it("jumps to last line with G", () => {
        const result = runSequence({ value: "one\ntwo\nthree", cursor: 1 }, [{ key: "Escape" }, { key: "G" }]);
        expect(result.state.mode).toBe("normal");
        expect(result.cursor).toBe("one\ntwo\n".length);
    });

    it("enters visual line mode with V", () => {
        const result = runSequence({ value: "alpha\nbeta\ngamma", cursor: 2 }, [{ key: "Escape" }, { key: "V" }]);
        expect(result.state.mode).toBe("visualLine");
        expect(result.state.visualSelection).toMatchObject({ start: 0, end: "alpha\n".length });
    });

    it("yanks multiple lines in visual line mode", () => {
        const result = runSequence({ value: "a\nb\nc\nd", cursor: 0 }, [
            { key: "Escape" },
            { key: "V" },
            { key: "j" },
            { key: "y" },
        ]);
        expect(result.state.mode).toBe("normal");
        expect(result.state.register).toMatchObject({ text: "a\nb\n", kind: "line" });
    });

    it("extends visual selection with repeated j presses", () => {
        const result = runSequence({ value: "l1\nl2\nl3\nl4\nl5", cursor: 0 }, [
            { key: "Escape" },
            { key: "V" },
            { key: "j" },
            { key: "j" },
            { key: "j" },
        ]);
        expect(result.state.mode).toBe("visualLine");
        expect(result.state.visualSelection).toMatchObject({ start: 0, end: "l1\nl2\nl3\nl4\n".length });
    });

    it("returns submit action on Enter in insert mode", () => {
        const submitResult = processVimKey(
            {
                value: "echo 1",
                mode: "insert",
                pendingOperator: null,
                register: null,
                visualAnchor: null,
                visualSelection: null,
            },
            6,
            6,
            { key: "Enter" }
        );
        expect(submitResult.action).toBe("submit");
    });

    it("returns cancel action on Escape in normal mode", () => {
        const cancelResult = processVimKey(
            {
                value: "echo 1",
                mode: "normal",
                pendingOperator: null,
                register: null,
                visualAnchor: null,
                visualSelection: null,
            },
            0,
            0,
            { key: "Escape" }
        );
        expect(cancelResult.action).toBe("cancel");
    });
});
