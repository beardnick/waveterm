type YankKind = "line" | "char";

export type YankRegister = {
    text: string;
    kind: YankKind;
} | null;

export type VimPasteResult = {
    value: string;
    cursor: number;
    mode: "normal" | "insert";
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const normalizeNewlines = (text: string) => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const detectNewlineStyle = (text: string): "\r\n" | "\r" | "\n" => {
    if (text.includes("\r\n")) {
        return "\r\n";
    }
    if (text.includes("\r") && !text.includes("\n")) {
        return "\r";
    }
    return "\n";
};

const denormalizeNewlines = (text: string, style: "\r\n" | "\r" | "\n"): { text: string; cursorMap: number[] } => {
    if (style === "\n") {
        const map = Array.from({ length: text.length + 1 }, (_, idx) => idx);
        return { text, cursorMap: map };
    }

    let converted = "";
    const map: number[] = new Array(text.length + 1);
    let outIdx = 0;
    for (let i = 0; i < text.length; i++) {
        map[i] = outIdx;
        const ch = text[i];
        if (ch === "\n") {
            if (style === "\r") {
                converted += "\r";
                outIdx += 1;
            } else {
                converted += "\r\n";
                outIdx += 2;
            }
        } else {
            converted += ch;
            outIdx += 1;
        }
    }
    map[text.length] = outIdx;
    return { text: converted, cursorMap: map };
};

const normalizeCursor = (value: string, cursor: number) => normalizeNewlines(value.slice(0, cursor)).length;

const computeLineStart = (text: string, pos: number) => {
    if (text.length === 0 || pos <= 0) {
        return 0;
    }
    const idx = text.lastIndexOf("\n", Math.min(pos, text.length) - 1);
    return idx === -1 ? 0 : idx + 1;
};

const computeLineEnd = (text: string, pos: number) => {
    if (text.length === 0) {
        return 0;
    }
    const idx = text.indexOf("\n", pos);
    return idx === -1 ? text.length : idx;
};

const computeNextLineStart = (text: string, pos: number) => {
    const end = computeLineEnd(text, pos);
    return end >= text.length ? text.length : end + 1;
};

const ensureLineRegisterNewline = (text: string) => (text.endsWith("\n") ? text : text + "\n");

export function applyVimPaste(value: string, cursor: number, register: YankRegister): VimPasteResult {
    const newlineStyle = detectNewlineStyle(value);
    const normalizedValue = normalizeNewlines(value);
    const normalizedCursor = normalizeCursor(value, cursor);
    const safeCursor = clamp(normalizedCursor, 0, normalizedValue.length);

    if (!register || !register.text) {
        const { text: finalValue, cursorMap } = denormalizeNewlines(normalizedValue, newlineStyle);
        return {
            value: finalValue,
            cursor: cursorMap[clamp(safeCursor, 0, cursorMap.length - 1)],
            mode: "normal",
        };
    }

    const normalizedRegister = normalizeNewlines(register.text);

    if (register.kind === "line") {
        const textToInsert = ensureLineRegisterNewline(normalizedRegister);
        const insertionPoint = computeNextLineStart(normalizedValue, safeCursor);
        const prefixBase = normalizedValue.slice(0, insertionPoint);
        const suffix = normalizedValue.slice(insertionPoint);
        const prefix = prefixBase.endsWith("\n") || prefixBase.length === 0 ? prefixBase : prefixBase + "\n";
        const newValue = prefix + textToInsert + suffix;
        const newCursor = clamp(prefix.length, 0, newValue.length);
        const { text: finalValue, cursorMap } = denormalizeNewlines(newValue, newlineStyle);
        return {
            value: finalValue,
            cursor: cursorMap[clamp(newCursor, 0, cursorMap.length - 1)],
            mode: "normal",
        };
    }

    const insertPos = Math.min(safeCursor + 1, normalizedValue.length);
    const newValue = normalizedValue.slice(0, insertPos) + normalizedRegister + normalizedValue.slice(insertPos);
    const newCursor = clamp(
        insertPos + normalizedRegister.length - 1,
        0,
        newValue.length > 0 ? newValue.length - 1 : 0
    );
    const { text: finalValue, cursorMap } = denormalizeNewlines(newValue, newlineStyle);
    return {
        value: finalValue,
        cursor: cursorMap[clamp(newCursor, 0, cursorMap.length - 1)],
        mode: "normal",
    };
}
