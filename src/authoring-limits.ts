/** Limits apply before parsing, policy/source inspection, or approval serialization. */
const maximumPayloadBytes = 1024 * 1024;
const maximumStringBytes = 256 * 1024;
const maximumCollectionEntries = 256;
const maximumDepth = 32;

/** Count the JSON envelope without first allocating its serialized representation. */
export function assertBoundedAuthoringInput(value: unknown): void {
  let bytes = 0;
  const ancestors = new Set<object>();

  function addBytes(count: number): void {
    bytes += count;
    if (bytes > maximumPayloadBytes) throw new Error("authoring payload exceeds 1 MiB");
  }

  function stringBytes(text: string): void {
    if (text.length > maximumStringBytes || Buffer.byteLength(text) > maximumStringBytes)
      throw new Error("authoring string exceeds 256 KiB");
    // Six bytes per UTF-16 code unit conservatively covers JSON escaping.
    addBytes(2);
    for (const character of text) {
      const code = character.charCodeAt(0);
      addBytes(
        code < 32 || (code >= 0xd800 && code <= 0xdfff && character.length === 1)
          ? 6
          : character === '"' || character === "\\"
            ? 2
            : Buffer.byteLength(character),
      );
    }
  }

  function visit(item: unknown, depth: number): void {
    if (depth > maximumDepth) throw new Error("authoring payload exceeds 32 nesting levels");
    if (typeof item === "string") return stringBytes(item);
    if (
      item === undefined ||
      item === null ||
      typeof item === "boolean" ||
      typeof item === "number"
    ) {
      addBytes(24);
      return;
    }
    if (typeof item !== "object") throw new Error("authoring payload must contain JSON values");
    if (ancestors.has(item)) throw new Error("authoring payload must not contain cycles");
    ancestors.add(item);
    addBytes(2);
    let count = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (++count > maximumCollectionEntries)
        throw new Error("authoring collections exceed 256 entries");
      if (!Array.isArray(item)) stringBytes(key);
      addBytes(2);
      visit((item as Record<string, unknown>)[key], depth + 1);
    }
    if (Array.isArray(item) && item.length > maximumCollectionEntries)
      throw new Error("authoring collections exceed 256 entries");
    ancestors.delete(item);
  }

  visit(value, 0);
}
