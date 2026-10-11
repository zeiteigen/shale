/** Offsets use JavaScript UTF-16 units, matching evidence validation. Never split a surrogate pair. */
export function textSpan(text:string,start:number,end:number):{text:string;start:number;end:number} {
  start=Math.max(0,Math.min(start,text.length));end=Math.max(start,Math.min(end,text.length));
  const split=(at:number)=>at>0&&at<text.length&&/[\uD800-\uDBFF]/.test(text[at-1]!)&&/[\uDC00-\uDFFF]/.test(text[at]!);
  if(split(start)) start++;
  if(split(end)) end--;
  return {text:text.slice(start,end),start,end};
}
