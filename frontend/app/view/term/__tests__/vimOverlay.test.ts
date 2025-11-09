import { describe, expect, it } from "vitest";

import { applyVimPaste } from "../vimOverlayUtils";

describe("applyVimPaste", () => {
    it("pastes linewise register below the current line and keeps cursor at start of new line", () => {
        const value = "line1\nline2\n";
        const cursor = 2; // position inside "line1"
        const register = { text: "line1\n", kind: "line" } as const;

        const result = applyVimPaste(value, cursor, register);

        expect(result.value).toBe("line1\nline1\nline2\n");
        expect(result.cursor).toBe(6); // start index of the pasted line
        expect(result.mode).toBe("normal");
    });

    it("keeps cursor on pasted line when duplicating top line", () => {
        const value = "line1\nline2\nline3";
        const cursor = 2; // inside the first line
        const register = { text: "line1\n", kind: "line" } as const;

        const result = applyVimPaste(value, cursor, register);

        expect(result.value).toBe("line1\nline1\nline2\nline3");
        // after pasting, cursor should be at the start of the second line ("line1" duplicate)
        expect(result.cursor).toBe("line1\n".length); // index == 6
    });

    it("pastes linewise register in the middle of several lines", () => {
        const value = ["for i in {1..10};", "do", "echo $i;", "done", "echo done"].join("\n") + "\n";
        const cursor = value.indexOf("echo $i;"); // inside third line
        const register = { text: "echo $i;\n", kind: "line" } as const;

        const result = applyVimPaste(value, cursor, register);

        const expected = ["for i in {1..10};", "do", "echo $i;", "echo $i;", "done", "echo done"].join("\n") + "\n";
        expect(result.value).toBe(expected);
        const first = expected.indexOf("echo $i;");
        const second = expected.indexOf("echo $i;", first + "echo $i;".length);
        expect(result.cursor).toBe(second);
    });

    it("pastes linewise register when buffer uses carriage returns", () => {
        const value = ["line1", "line2", "line3"].join("\r") + "\r";
        const cursor = value.indexOf("line2");
        const register = { text: "lineX\r", kind: "line" } as const;

        const result = applyVimPaste(value, cursor, register);

        const expected = ["line1", "line2", "lineX", "line3"].join("\r") + "\r";
        expect(result.value).toBe(expected);
        const second = expected.indexOf("lineX");
        expect(result.cursor).toBe(second);
    });

    it("pastes charwise register after the cursor and keeps cursor on last inserted char", () => {
        const value = "abc";
        const cursor = 1;
        const register = { text: "XYZ", kind: "char" } as const;

        const result = applyVimPaste(value, cursor, register);

        expect(result.value).toBe("abXYZc");
        expect(result.cursor).toBe(4); // last character of inserted text
        expect(result.mode).toBe("normal");
    });

    it("pastes charwise register with CR newlines in buffer", () => {
        const value = "foo\rbar";
        const cursor = 2;
        const register = { text: "XYZ", kind: "char" } as const;

        const result = applyVimPaste(value, cursor, register);

        expect(result.value).toBe("fooXYZ\rbar");
        expect(result.cursor).toBe(5);
    });

    it("handles empty register by no-op", () => {
        const value = "abc";
        const cursor = 1;
        const register = null;

        const result = applyVimPaste(value, cursor, register);

        expect(result.value).toBe(value);
        expect(result.cursor).toBe(cursor);
        expect(result.mode).toBe("normal");
    });
});
