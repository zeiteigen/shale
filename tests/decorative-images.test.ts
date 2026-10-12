import { expect, it } from "bun:test";
import { isDecorativeImage, isDecorativeImageUrl } from "../lib/decorative-images";
import { markdownImages, omitMarkdownImages } from "../lib/markdown-images";
import { parseNoteContent } from "../extensions/obsidian/parser";

const favicon = 'https://t0.gstatic.com/faviconV2?client=BARD&type=FAVICON&size=256&url=https%3A%2F%2Fexample.com';

it('recognizes asset paths without excluding articles, diagram hosts, or small illustrations', () => {
  for (const url of [favicon,'favicon.ico','file:///vault/apple-touch-icon-180x180.png',
    'https://www.google.com/s2/favicons?domain=example.com','https://cdn.test/ICON-SPRITE.svg'])
    expect(isDecorativeImageUrl(url)).toBe(true);
  for (const url of ['https://example.com/favicon-guide.html','https://example.com/article?url='+encodeURIComponent(favicon),
    'https://encrypted-tbn2.gstatic.com/licensed-image?q=diagram','plot.svg','my-icon-study.png'])
    expect(isDecorativeImageUrl(url)).toBe(false);
  expect(isDecorativeImage({url:'https://example.com/pixel.gif',width:1,height:1})).toBe(true);
  expect(isDecorativeImage({url:'chart.png',width:500,height:30})).toBe(false);
  expect(isDecorativeImage({url:'chart.png',width:1})).toBe(false);
  expect(isDecorativeImage({url:'chart.png'})).toBe(false);
});

it('removes only decorative image spans while preserving citation links, titles, and literal code', () => {
  const icon=`![](${favicon})`;
  const text=`[${icon} Research paper](https://example.com/paper)\n![Plot](https://example.com/plot(a).png "A chart")\n`
    + '![[favicon.png|32]]\n![[diagram.png|300]]\n' + '`'+icon+'`\n~~~md\n'+icon+'\n~~~\n'
    + '\\'+icon;
  const cleaned=omitMarkdownImages(text,isDecorativeImageUrl);
  expect(cleaned).toBe(text.replace(icon,'').replace('![[favicon.png|32]]',''));
  expect(markdownImages(cleaned).map(i=>i.target)).toEqual(['https://example.com/plot(a).png','diagram.png']);
  const parsed=parseNoteContent(text,'Research');
  expect(parsed.rawContent).toBe(text);
  expect(parsed.body).toBe(cleaned.trim());
  expect(parsed.images).toEqual(['https://example.com/plot(a).png','diagram.png']);
});

it('supports angle destinations and CRLF code fences without modifying code samples', () => {
  const text='![icon](<'+favicon+'> "Icon")\r\n```md\r\n![]('+favicon+')\r\n```\r\n![plot](plot.png)';
  expect(markdownImages(text).map(i=>i.target)).toEqual([favicon,'plot.png']);
  expect(omitMarkdownImages(text,isDecorativeImageUrl)).toBe(text.slice(text.indexOf('\r\n')));
});

it('preserves indented code image syntax',()=>{
  const text='Example:\n\n    ![]('+favicon+')\n\t![[favicon.png]]\n![plot](plot.png)';
  expect(omitMarkdownImages(text,isDecorativeImageUrl)).toBe(text);
  expect(markdownImages(text).map(i=>i.target)).toEqual(['plot.png']);
});
