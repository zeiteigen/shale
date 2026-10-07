import { expect, it } from "bun:test";
import { packDocumentChunks } from "../extensions/process-document/document-chunks";

it("packs adjacent fragments within their size, location, heading, and provenance boundaries", () => {
  const chunks = [
    { text: "First", metadata: { pageNumber: 1, closestHeading: "A" } },
    { text: "paragraph", metadata: { closestHeading: "A", pageNumber: 1 } },
    { text: "next", metadata: { pageNumber: 1, closestHeading: "A" } },
    { text: "New heading", metadata: { pageNumber: 1, closestHeading: "B" } },
    { text: "New page", metadata: { pageNumber: 2, closestHeading: "B" } },
    { text: "Table", metadata: { pageNumber: 2, closestHeading: "B", isTableChunk: true } },
    { text: "Vision", metadata: { pageNumber: 2, closestHeading: "B", extractionMethod: "vision-transcription", model: "model" } },
  ];
  const packed = packDocumentChunks(chunks, 20);
  expect(packed[0].text).toBe("First\n\nparagraph");
  expect(packed).toHaveLength(6);
  expect(packed.every(chunk => chunk.text.length <= 20)).toBe(true);
  expect(packed.map(chunk => chunk.text).join("\n\n")).toBe(chunks.map(chunk => chunk.text).join("\n\n"));
  expect(chunks[0].text).toBe("First");
});
