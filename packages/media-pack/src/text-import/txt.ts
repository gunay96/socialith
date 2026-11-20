import { TextImportError } from "./errors.js";

export type TxtSplit = "LINE" | "BLANK_LINE";

/**
 * A plain text file as a list of texts. "LINE": every non-empty line is one text. "BLANK_LINE": texts are separated by
 * blank lines and may span several lines. "auto" (the default) uses BLANK_LINE when the file has blank-line separated
 * blocks that contain more than one line, otherwise LINE. `startLines` are 1-based line numbers, for error messages.
 */
export function parseTxt(text: string, options: { maxRows: number; split?: TxtSplit | "auto" }): { texts: string[]; startLines: number[]; split: TxtSplit } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: { text: string; start: number }[] = [];
  let current: string[] = [];
  let start = 0;
  lines.forEach((line, i) => {
    if (line.trim() === "") {
      if (current.length) blocks.push({ text: current.join("\n"), start });
      current = [];
    } else {
      if (!current.length) start = i + 1;
      current.push(line);
    }
  });
  if (current.length) blocks.push({ text: current.join("\n"), start });

  const wanted = options.split ?? "auto";
  const split: TxtSplit = wanted === "auto" ? (blocks.length > 1 && blocks.some((b) => b.text.includes("\n")) ? "BLANK_LINE" : "LINE") : wanted;
  const out: { text: string; start: number }[] =
    split === "BLANK_LINE"
      ? blocks
      : lines.flatMap((line, i) => (line.trim() === "" ? [] : [{ text: line, start: i + 1 }]));
  if (out.length > options.maxRows) throw new TextImportError("TOO_MANY_ROWS", `The file has more than ${options.maxRows} texts. Split it into smaller files.`);
  if (out.length === 0) throw new TextImportError("NO_ROWS", "The file contains no text.");
  return { texts: out.map((o) => o.text), startLines: out.map((o) => o.start), split };
}
