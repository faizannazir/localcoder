type Encoding = "utf-8" | "utf-16le" | "utf-16be";
export type LineEnding = "\n" | "\r\n" | "\r";

export interface WorkspaceText {
  text: string;
  encoding: Encoding;
  bom: Buffer;
  /** null indicates mixed line endings. undefined means the file has no line breaks. */
  lineEnding: LineEnding | null | undefined;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16_LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16_BE_BOM = Buffer.from([0xfe, 0xff]);
const EMPTY = Buffer.alloc(0);
const startsWith = (bytes: Buffer, prefix: Buffer) => bytes.subarray(0, prefix.length).equals(prefix);
export const lineEndings = (text: string) => text.match(/\r\n|\n|\r/g) ?? [];

export function decodeWorkspaceText(bytes: Buffer): WorkspaceText {
  let encoding: Encoding = "utf-8";
  let bom = EMPTY;
  if (startsWith(bytes, UTF8_BOM)) {
    bom = UTF8_BOM;
  } else if (startsWith(bytes, UTF16_LE_BOM)) {
    encoding = "utf-16le";
    bom = UTF16_LE_BOM;
  } else if (startsWith(bytes, UTF16_BE_BOM)) {
    encoding = "utf-16be";
    bom = UTF16_BE_BOM;
  }
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(bom.length));
  } catch {
    throw new Error("Unsupported or invalid file encoding. Expected UTF-8 or UTF-16 with a BOM.");
  }
  if (text.includes("\0")) throw new Error("Binary file or unsupported file encoding.");
  let lineEnding: LineEnding | null | undefined;
  for (const [ending] of text.matchAll(/\r\n|\n|\r/g)) {
    if (lineEnding !== undefined && lineEnding !== ending) { lineEnding = null; break; }
    lineEnding = ending as LineEnding;
  }
  return { text, encoding, bom, lineEnding };
}

export function encodeWorkspaceText(text: string, original?: WorkspaceText): Buffer {
  const body = Buffer.from(text, !original || original.encoding === "utf-8" ? "utf8" : "utf16le");
  if (original?.encoding === "utf-16be") body.swap16();
  const bytes = original?.bom.length ? Buffer.concat([original.bom, body]) : body;
  if (decodeWorkspaceText(bytes).text !== text) throw new Error("The edit contains text that cannot be represented in the file's encoding.");
  return bytes;
}

export const matchLineEndings = (text: string, lineEnding: LineEnding | null | undefined) =>
  lineEnding ? text.replace(/\r\n|\n|\r/g, lineEnding) : text;
