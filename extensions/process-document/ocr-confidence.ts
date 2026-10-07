/** Tesseract word confidence, weighted by word length; blank pages score zero. */
export function ocrConfidence(tsv: string): number {
  let total = 0, weight = 0;
  for (const line of tsv.split("\n").slice(1)) {
    const columns = line.split("\t"), confidence = Number(columns[10]);
    const length = (columns[11] ?? "").trim().length;
    if (columns[0] !== "5" || !length || !Number.isFinite(confidence) || confidence < 0) continue;
    total += confidence * length; weight += length;
  }
  return weight ? total / weight : 0;
}
