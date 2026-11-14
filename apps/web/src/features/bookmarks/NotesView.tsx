import { useMemo } from 'react';
import { renderMarkdown } from './renderMarkdown';

/** Rendered, sanitised Markdown. Default export so it can be `React.lazy`-loaded. */
export default function NotesView({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return (
    <div
      className="space-y-1.5 text-sm leading-snug text-fg [&_a]:text-accent-text [&_a]:underline [&_code]:rounded-sm [&_code]:bg-surface-3 [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-4 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-surface-2 [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-4"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
