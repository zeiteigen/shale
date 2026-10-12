import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import './rich-text.css';

function overviewMarkdown(text: string) {
  // The extractive writer uses bullets with unindented continuations. Display them
  // as Markdown list items without changing the retained summary or its citations.
  return text.split(/\n(?=• )/).map(part => part.startsWith('• ')
    ? part.replace(/^• /, '- ').split('\n').map((line, index) => index ? `  ${line}` : line).join('\n')
    : part).join('\n');
}

export default function RichText({ text, extractive }: { text: string; extractive?: boolean }) {
  return <div className="rich-text"><Markdown
    skipHtml
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[[rehypeKatex, { strict: false, trust: false, throwOnError: false, maxExpand: 1000 }]]}
    components={{
      a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>,
      // Source images stay explicit links; opening a snippet never contacts their hosts.
      img: ({ src, alt }) => src ? <a href={src} target="_blank" rel="noreferrer">{alt || 'Open source image'} ↗</a> : <span>{alt}</span>,
      table: ({ children }) => <div className="rich-table"><table>{children}</table></div>,
    }}
  >{extractive ? overviewMarkdown(text) : text}</Markdown></div>;
}
