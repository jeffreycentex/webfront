// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { duplicateKey, parseBookmarksHtml, type ImportFolder } from './parseNetscape';

const HEAD = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
`;

const CHROME =
  HEAD +
  `<DL><p>
  <DT><H3 ADD_DATE="1" LAST_MODIFIED="2" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
  <DL><p>
    <DT><A HREF="https://loose.example.com/" ADD_DATE="3" ICON="data:image/png;base64,AAAA">Loose link</A>
    <DT><H3 ADD_DATE="4">Dev</H3>
    <DL><p>
      <DT><A HREF="https://github.com/" ADD_DATE="5">GitHub</A>
      <DT><H3>Editors</H3>
      <DL><p>
        <DT><A HREF="https://code.visualstudio.com/">VS Code</A>
        <DT><H3>Plugins</H3>
        <DL><p>
          <DT><A HREF="https://plugins.example.com/">Plugins</A>
        </DL><p>
      </DL><p>
    </DL><p>
    <DT><H3>Empty</H3>
    <DL><p></DL><p>
  </DL><p>
  <DT><H3 ADD_DATE="1">Other bookmarks</H3>
  <DL><p>
    <DT><H3>Reading</H3>
    <DL><p>
      <DT><A HREF="https://news.example.com/a">News A</A>
    </DL><p>
  </DL><p>
</DL><p>
`;

const FIREFOX =
  HEAD +
  `<DL><p>
  <DT><H3 ADD_DATE="1" LAST_MODIFIED="2">Mozilla Firefox</H3>
  <DL><p>
    <DT><A HREF="https://support.mozilla.org/" ADD_DATE="1" ICON_URI="fake-favicon-uri:x" TAGS="help, firefox ,Help">Help</A>
    <DD>Get help with Firefox
    <DT><A HREF="place:parent=1&amp;type=6" ADD_DATE="1">Recent Tags</A>
    <DT><A HREF="https://x.example/" SHORTCUTURL="x">Shortcut</A>
  </DL><p>
  <DT><H3 ADD_DATE="1" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks Toolbar</H3>
  <DD>Add bookmarks to this folder
  <DL><p>
    <DT><A HREF="https://toolbar.example.com/">Toolbar link</A>
  </DL><p>
  <DT><H3 UNFILED_BOOKMARKS_FOLDER="true">Other Bookmarks</H3>
  <DL><p>
    <DT><A HREF="https://other.example.com/">Other link</A>
  </DL><p>
</DL>
`;

const SAFARI = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<HTML>
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 FOLDED ADD_DATE="1">BookmarksBar</H3>
    <DL><p>
        <DT><A HREF="https://apple.example.com/">Apple</A>
    </DL><p>
    <DT><H3 FOLDED ADD_DATE="1">Reading List</H3>
    <DL><p>
        <DT><A HREF="https://read.example.com/">Read me</A>
    </DL><p>
</DL><p>
</HTML>
`;

function names(fs: ImportFolder[]): string[] {
  return fs.map((f) => f.name);
}
function parse(text: string, limits?: Parameters<typeof parseBookmarksHtml>[1]) {
  const r = parseBookmarksHtml(text, limits);
  if (!r.ok) throw new Error(r.error);
  return r.parsed;
}

describe('parseBookmarksHtml: Chrome style', () => {
  const p = parse(CHROME);
  it('unwraps the bookmarks bar and other bookmarks, keeps file order, drops empty folders', () => {
    expect(names(p.categories)).toEqual(['Dev', 'Reading', 'Imported']);
    expect(p.categories[2]!.links.map((l) => l.title)).toEqual(['Loose link']);
  });
  it('flattens folders deeper than two levels into the sub-category with a path tag', () => {
    const dev = p.categories[0]!;
    expect(dev.links.map((l) => l.title)).toEqual(['GitHub']);
    expect(names(dev.subs)).toEqual(['Editors']);
    const editors = dev.subs[0]!;
    expect(editors.links.map((l) => [l.title, l.tags])).toEqual([
      ['VS Code', []],
      ['Plugins', ['Plugins']],
    ]);
    expect(p.categories[1]!.links.map((l) => l.title)).toEqual(['News A']);
  });
  it('ignores embedded icon data and counts links', () => {
    expect(JSON.stringify(p)).not.toContain('base64');
    expect(p.linkCount).toBe(5);
    expect(p.skippedTotal).toBe(0);
  });
});

describe('parseBookmarksHtml: Firefox style', () => {
  const p = parse(FIREFOX);
  it('imports tags (deduplicated) and descriptions as notes', () => {
    const help = p.categories[0]!.links[0]!;
    expect(help.tags).toEqual(['help', 'firefox']);
    expect(help.notes).toBe('Get help with Firefox');
  });
  it('unwraps wrappers found by attribute and skips place: links', () => {
    expect(names(p.categories)).toEqual(['Mozilla Firefox', 'Imported']);
    expect(p.categories[1]!.links.map((l) => l.title)).toEqual(['Toolbar link', 'Other link']);
    expect(p.skipped.place).toBe(1);
    expect(p.categories[0]!.links.map((l) => l.title)).toEqual(['Help', 'Shortcut']);
  });
});

describe('parseBookmarksHtml: Safari style', () => {
  it('unwraps BookmarksBar, keeps Reading List as a category', () => {
    const p = parse(SAFARI);
    expect(names(p.categories)).toEqual(['Reading List', 'Imported']);
  });
});

describe('skipped schemes', () => {
  it('counts and skips non-http links by reason', () => {
    const html =
      HEAD +
      `<DL><p>
      <DT><A HREF="javascript:alert(1)">bm</A>
      <DT><A HREF=" JaVaScRiPt:alert(1)">bm2</A>
      <DT><A HREF="place:sort=8">p</A>
      <DT><A HREF="chrome://settings">c</A>
      <DT><A HREF="about:blank">a</A>
      <DT><A HREF="edge://favorites">e</A>
      <DT><A HREF="file:///etc/passwd">f</A>
      <DT><A HREF="data:text/html,hi">d</A>
      <DT><A HREF="ftp://files.example.com/">ftp</A>
      <DT><A HREF="mailto:a@b.c">m</A>
      <DT><A>nohref</A>
      <DT><A HREF="https://ok.example.com/">ok</A>
    </DL>`;
    const p = parse(html);
    expect(p.skipped).toEqual({
      bookmarklet: 2,
      place: 1,
      browser: 3,
      file: 1,
      data: 1,
      other: 2,
      invalid: 1,
    });
    expect(p.linkCount).toBe(1);
    expect(p.categories[0]!.links.map((l) => l.url)).toEqual(['https://ok.example.com/']);
  });
});

describe('limits and bad input', () => {
  it('rejects files over the size cap and over the link cap with a clear message', () => {
    const big = parseBookmarksHtml(CHROME, { maxBytes: 100 });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error).toMatch(/larger than/);
    const many = parseBookmarksHtml(CHROME, { maxLinks: 2 });
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.error).toMatch(/limit is 2/);
  });
  it('rejects files that are not bookmark exports', () => {
    expect(parseBookmarksHtml('{"roots":{}}').ok).toBe(false);
    expect(parseBookmarksHtml('<html><body><p>hi</p></body></html>').ok).toBe(false);
  });
  it('survives pathological nesting', () => {
    const html = HEAD + '<DL>'.repeat(2000) + '<DT><A HREF="https://deep.example.com/">deep</A>';
    const r = parseBookmarksHtml(html);
    expect(r.ok).toBe(true);
  });
});

describe('hostile file', () => {
  const w = window as unknown as Record<string, unknown>;
  const html =
    HEAD +
    `<DL><p>
    <DT><H3>Evil <script>window.__pwned = 'folder'</script></H3>
    <DL><p>
      <DT><A HREF="https://a.example.com/" onclick="window.__pwned='click'" onmouseover="window.__pwned='x'">Nice <img src=x onerror="window.__pwned='img'">title</A>
      <DT><A HREF="javascript:window.__pwned='js'">bookmarklet</A>
      <DT><A HREF="https://b.example.com/"><script>window.__pwned='script'</script>Second</A>
      <DD><img src=x onerror="window.__pwned='dd'">described <b>boldly</b>
    </DL><p>
    <script>window.__pwned = 'top'</script>
    <body onload="window.__pwned='body'">
  </DL>`;
  it('runs nothing and yields only plain text', () => {
    delete w.__pwned;
    const p = parse(html);
    expect(w.__pwned).toBeUndefined();
    const all = p.categories.flatMap((c) => [c, ...c.subs]);
    for (const f of all) {
      expect(f.name).not.toMatch(/[<>]/);
      for (const l of f.links) {
        expect(l.title).not.toMatch(/[<>]/);
        expect(l.notes).not.toMatch(/[<>]/);
        expect(l.url).toMatch(/^https:/);
      }
    }
    const links = all.flatMap((f) => f.links);
    expect(links.map((l) => l.title)).toEqual(['Nice title', 'Second']);
    expect(links[1]!.notes).toBe('described boldly');
    expect(p.skipped.bookmarklet).toBe(1);
    // The live page is untouched.
    expect(document.querySelectorAll('script, img').length).toBe(0);
  });
});

describe('duplicateKey', () => {
  it('ignores host case, fragment, trailing slash and default port; keeps scheme, path case and query', () => {
    const k = duplicateKey('https://Example.COM/Path/#frag');
    expect(k).toBe(duplicateKey('https://example.com:443/Path'));
    expect(duplicateKey('https://example.com/')).toBe(duplicateKey('https://EXAMPLE.com'));
    expect(duplicateKey('https://example.com/a?x=1')).not.toBe(
      duplicateKey('https://example.com/a'),
    );
    expect(duplicateKey('http://example.com/')).not.toBe(duplicateKey('https://example.com/'));
    expect(duplicateKey('https://example.com/Path')).not.toBe(
      duplicateKey('https://example.com/path'),
    );
    expect(duplicateKey('javascript:1')).toBeNull();
  });
});
