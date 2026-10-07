/** FTS snippets contain highlight markers; render their content as plain text. */
export function searchPreview(value: string, maximum = 118) {
  const text = value.replace(/<\/?mark>/g, "").replace(/\s+/g, " ").trim();
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}
