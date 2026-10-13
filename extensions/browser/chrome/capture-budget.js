/** Keep the complete wire record bounded, including escaped HTML and long references. */
export function fitCapture(record, maxBytes = 450000) {
  const bytes = (value) =>
    new TextEncoder().encode(JSON.stringify(value)).length;
  if (bytes(record) <= maxBytes) return record;
  const result = {
    ...record,
    html: "",
    links: [...(record.links || [])],
    images: [...(record.images || [])],
    blocks: [...(record.blocks || [])],
    extraction: {
      ...record.extraction,
      truncated: true,
      quality:
        record.extraction.quality === "metadata" ? "metadata" : "partial",
      reasons: [
        ...record.extraction.reasons,
        "Capture exceeded wire byte budget",
      ].slice(0, 20),
    },
  };
  while (result.links.length && bytes(result) > maxBytes) result.links.pop();
  while (result.images.length && bytes(result) > maxBytes) result.images.pop();
  while (result.blocks.length > 1 && bytes(result) > maxBytes) {
    result.blocks.pop();
    result.textContent = result.blocks.map((block) => block.text).join("\n\n");
  }
  if (bytes(result) > maxBytes) {
    result.blocks = [];
    while (bytes(result) > maxBytes && result.textContent.length > 1)
      result.textContent = result.textContent.slice(
        0,
        Math.ceil(result.textContent.length / 2),
      );
  }
  if (bytes(result) > maxBytes)
    throw new Error("Capture metadata exceeds byte budget");
  return result;
}
