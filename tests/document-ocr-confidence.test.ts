import { expect, it } from "bun:test";
import { ocrConfidence } from "../extensions/process-document/ocr-confidence";

it("uses word confidence without counting layout records or blank pages", () => {
  const header = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
  const word = (level: number, confidence: string, text: string) => `${level}\t1\t1\t1\t1\t1\t0\t0\t1\t1\t${confidence}\t${text}`;
  const tsv = [header, word(1, "-1", ""), word(5, "90", "longword"), word(5, "10", "hi"), word(5, "-1", "ignored"), word(5, "invalid", "ignored")].join("\n");
  expect(ocrConfidence(tsv)).toBe(74);
  expect(ocrConfidence(header)).toBe(0);
});
