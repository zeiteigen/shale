import { expect, test } from "bun:test";
import { searchPreview } from "../visualizer/src/search-preview";

test("search previews remove FTS markers before measuring and clipping text", () => {
  expect(searchPreview("  <mark>Torvald</mark>\n Helmer  ")).toBe("Torvald Helmer");
  expect(searchPreview("<mark>Torvald</mark> Helmer", 10)).toBe("Torvald He…");
  expect(searchPreview("<mark>Torvald</mark>", 7)).toBe("Torvald");
});
