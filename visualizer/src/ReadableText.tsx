import { lazy, Suspense } from 'react';

const RichText = lazy(() => import('./RichText'));

/** Load the formatter when retained text is opened, keeping the graph's initial load small. */
export function ReadableText({ text, extractive = false }: { text: string; extractive?: boolean }) {
  return <Suspense fallback={<p>{text}</p>}><RichText text={text} extractive={extractive} /></Suspense>;
}
