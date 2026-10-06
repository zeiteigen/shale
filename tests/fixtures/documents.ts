import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";

function writeZip(directory: string, filename: string, entries: Record<string, string>): string {
  const path = join(directory, filename);
  writeFileSync(path, zipSync(Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, strToU8(value)]))));
  return path;
}

/** Small real packages exercise parsers without a document-authoring runtime. */
export function writeDocumentFixtures(directory: string): Record<string, string> {
  const contentTypes = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>`;
  const docx = writeZip(directory, "report with spaces.docx", {
    "[Content_Types].xml": contentTypes,
    "docProps/core.xml": `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Research report</dc:title><dc:creator>Shale</dc:creator></cp:coreProperties>`,
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Findings</w:t></w:r></w:p><w:p><w:r><w:t>Local document extraction preserves evidence.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Accuracy</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>99 percent</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
  });
  const pptx = writeZip(directory, "slides.pptx", {
    "[Content_Types].xml": contentTypes,
    "ppt/presentation.xml": `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>`,
    "ppt/slides/slide1.xml": slide("First slide evidence"),
    "ppt/slides/slide2.xml": slide("Second slide findings"),
    "ppt/slides/_rels/slide1.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
    "ppt/notesSlides/notesSlide1.xml": slide("Speaker note context", "notes"),
  });
  const xlsx = writeZip(directory, "data.xlsx", {
    "[Content_Types].xml": contentTypes,
    "xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Results" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Document count</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>`,
  });
  const odt = writeZip(directory, "notes.odt", {
    mimetype: "application/vnd.oasis.opendocument.text",
    "content.xml": `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:h text:outline-level="1">OpenDocument notes</text:h><text:p>Open formats retain useful knowledge.</text:p></office:text></office:body></office:document-content>`,
  });
  const odp = writeZip(directory, "open-slides.odp", {
    mimetype: "application/vnd.oasis.opendocument.presentation",
    "content.xml": `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><office:body><office:presentation><draw:page draw:name="Overview"><draw:frame><draw:text-box><text:p>Open presentation evidence</text:p></draw:text-box></draw:frame></draw:page></office:presentation></office:body></office:document-content>`,
  });
  const ods = writeZip(directory, "open-data.ods", {
    mimetype: "application/vnd.oasis.opendocument.spreadsheet",
    "content.xml": `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><office:body><office:spreadsheet><table:table table:name="Counts"><table:table-row><table:table-cell office:value-type="string"><text:p>OpenDocument count</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="23"><text:p>23</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`,
  });
  const epub = writeZip(directory, "book.epub", {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    "book.opf": `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">shale-test</dc:identifier><dc:title>Fixture book</dc:title><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>`,
    "chapter.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><h1>Book evidence</h1><p>Electronic books contain searchable text.</p></body></html>`,
  });
  const pdf = join(directory, "paper.pdf");
  writeFileSync(pdf, textPdf(["First page evidence", "Second page findings"]));
  const paths = { docx, pptx, xlsx, odt, odp, ods, epub, pdf };
  const textFiles = {
    txt: "Plain document evidence.\nSecond paragraph contains details.",
    rtf: "{\\rtf1\\ansi Rich text evidence.\\par Second paragraph details.}",
    csv: "Name,Count\nEvidence,42\nDocuments,7",
    md: "# Markdown evidence\n\nLocal knowledge survives parsing.",
    html: "<html><body><h1>HTML evidence</h1><p>Readable document details.</p></body></html>",
  };
  const other: Record<string, string> = {};
  for (const [format, text] of Object.entries(textFiles)) {
    other[format] = join(directory, `document.${format}`);
    writeFileSync(other[format], text);
  }
  return { ...paths, ...other };
}

function slide(text: string, root = "sld"): string {
  return `<p:${root} xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Content"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:${root}>`;
}

/** Build a valid cross-reference table so the PDF test does not rely on repair. */
export function textPdf(pages: string[]): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (const text of pages) {
    const pageId = objects.length + 1;
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let content = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}
