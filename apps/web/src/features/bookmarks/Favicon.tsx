import { colourForLabel } from '@webfront/shared';
import { useState } from 'react';
import { colourStyle, cx } from '@/ui';
import { faviconSrc } from './api';
import { avatarLetter, hostOf } from './model';

/** Origins whose icon failed to load this session (avoids re-requesting known misses). */
const failed = new Set<string>();

/**
 * Site icon from the server's favicon cache. When the server has none (404), or while
 * offline, falls back to a coloured letter avatar derived from the host.
 */
export function Favicon({
  url,
  title,
  className,
}: {
  url: string;
  title: string;
  className?: string;
}) {
  const src = faviconSrc(url);
  const origin = src ?? url;
  const [, bump] = useState(0);
  if (!src || failed.has(origin)) {
    return (
      <span
        aria-hidden
        style={colourStyle(colourForLabel(hostOf(url)))}
        className={cx(
          'inline-flex size-4 shrink-0 items-center justify-center rounded-sm bg-[var(--c)] text-[10px] font-semibold leading-none text-white',
          className,
        )}
      >
        {avatarLetter(title, url)}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      width={16}
      height={16}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => {
        failed.add(origin);
        bump((n) => n + 1);
      }}
      className={cx('size-4 shrink-0 rounded-sm object-contain', className)}
    />
  );
}
