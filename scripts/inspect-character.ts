import { parseCharacterCard } from "@valerie/core";

const path = process.argv[2];
if (!path) {
  console.error("Usage: bun character:inspect /absolute/path/to/character.png");
  process.exitCode = 1;
} else {
  try {
    const file = Bun.file(path);
    if (file.size > 16 * 1024 * 1024) throw new Error("Source too large");
    const preview = parseCharacterCard(new Uint8Array(await file.arrayBuffer()));
    console.info(
      JSON.stringify(
        {
          format: preview.format,
          metadataKeyword: preview.metadataKeyword,
          sha256: preview.sha256,
          bytes: preview.originalBytes.length,
          fields: Object.fromEntries(
            Object.entries(preview.fields).map(([key, value]) => [
              key,
              typeof value === "string" ? { characters: value.length } : { present: value != null },
            ]),
          ),
          saved: false,
          note: "Inspection only. Original bytes and authored content have not been modified or imported.",
        },
        null,
        2,
      ),
    );
  } catch {
    console.error(
      "Could not inspect this character file. Use a readable PNG or JSON card within the documented size limits.",
    );
    process.exitCode = 1;
  }
}
