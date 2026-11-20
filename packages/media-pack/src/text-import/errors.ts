export type TextImportErrorCode =
  | "EMPTY_FILE"
  | "NOT_TEXT"
  | "TOO_MANY_ROWS"
  | "NO_TEXT_COLUMN"
  | "XLSX_INVALID"
  | "XLSX_UNSAFE"
  | "XLSX_NO_SHEET"
  | "NO_ROWS";

/** A whole file that cannot be imported, with a message a person can act on. */
export class TextImportError extends Error {
  constructor(
    readonly code: TextImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TextImportError";
  }
}
