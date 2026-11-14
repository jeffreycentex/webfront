import { useEffect, useRef } from 'react';
import { isMac } from '../lib/platform';

/**
 * Keyboard shortcuts.
 *
 *   useHotkeys({ 'mod+k': () => open(), 'g b': () => navigate('/bookmarks'), '?': showHelp });
 *
 * Syntax: steps separated by a space form a sequence ("g b": press g, then b within 1s). Within
 * a step, modifiers join with "+": `mod` (Cmd on macOS, Ctrl elsewhere), `ctrl`, `alt`, `meta`,
 * `shift`. Keys use `KeyboardEvent.key` names, lower-cased: `enter`, `escape`, `arrowdown`, `/`,
 * `?`. Shift is implied for printable symbols (so `?` just works) and must be spelled out for
 * letters (`shift+g`).
 *
 * Bindings without ctrl/meta/alt do not fire while typing in inputs, textareas, selects or
 * contenteditable (except `escape`), unless `allowInInput` is set. When several bindings match,
 * the one registered last (the most recently mounted component, e.g. an open dialog) wins and
 * the others do not fire.
 */
export type HotkeyHandler = (event: KeyboardEvent) => void | boolean;

export interface HotkeyOptions {
  /** Default true. */
  enabled?: boolean;
  /** Also fire while an input or textarea has focus. */
  allowInInput?: boolean;
  /** Call preventDefault when a binding fires (default true). */
  preventDefault?: boolean;
}

const SEQUENCE_TIMEOUT_MS = 1000;
const MODIFIER_KEYS = new Set(['control', 'alt', 'shift', 'meta', 'altgraph', 'capslock']);

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  space: ' ',
  spacebar: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  del: 'delete',
  plus: '+',
};

/** Canonical string for one step, e.g. `ctrl+k`, `shift+g`, `?`. */
function canonicalStep(spec: string, mac: boolean): string {
  const raw = spec.trim().toLowerCase();
  // A literal "+" key ("mod++" or just "+").
  const keyPart = raw === '+' || raw.endsWith('++') ? '+' : (raw.split('+').pop() ?? '');
  const modPart =
    raw === '+'
      ? []
      : raw.endsWith('++')
        ? raw.slice(0, -2).split('+')
        : raw.split('+').slice(0, -1);
  const mods = new Set<string>();
  for (const m of modPart) {
    if (m === 'mod') mods.add(mac ? 'meta' : 'ctrl');
    else if (m === 'cmd' || m === 'command') mods.add('meta');
    else if (m === 'option') mods.add('alt');
    else if (m === 'control') mods.add('ctrl');
    else if (m) mods.add(m);
  }
  const key = KEY_ALIASES[keyPart] ?? keyPart;
  return buildCanonical(mods, key);
}

function buildCanonical(mods: Set<string>, key: string): string {
  // Shift is already baked into printable symbols ("?", "/", "!"), so never part of the combo.
  if (key.length === 1 && key.toLowerCase() === key.toUpperCase()) mods.delete('shift');
  const out: string[] = [];
  for (const m of ['ctrl', 'alt', 'meta', 'shift']) if (mods.has(m)) out.push(m);
  out.push(key);
  return out.join('+');
}

function canonicalFromEvent(e: KeyboardEvent): string | null {
  const key = (e.key ?? '').toLowerCase();
  if (!key || MODIFIER_KEYS.has(key)) return null;
  const mods = new Set<string>();
  if (e.ctrlKey) mods.add('ctrl');
  if (e.altKey) mods.add('alt');
  if (e.metaKey) mods.add('meta');
  if (e.shiftKey) mods.add('shift');
  return buildCanonical(mods, key);
}

interface Binding {
  steps: string[];
  handler: () => HotkeyHandler;
  options: () => HotkeyOptions;
  /** Eligible while typing in a field. */
  alwaysInInput: boolean;
}

const bindings: Binding[] = [];
let buffer: string[] = [];
let bufferTimer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(
      type,
    );
  }
  return false;
}

function resetBuffer() {
  buffer = [];
  if (bufferTimer) clearTimeout(bufferTimer);
  bufferTimer = null;
}

function startsWith(steps: string[], prefix: string[]): boolean {
  return prefix.length <= steps.length && prefix.every((s, i) => steps[i] === s);
}

function eligible(b: Binding, editable: boolean): boolean {
  if (b.options().enabled === false) return false;
  if (!editable) return true;
  return b.alwaysInInput || b.options().allowInInput === true;
}

function onKeyDown(e: KeyboardEvent) {
  if (e.isComposing) return;
  const step = canonicalFromEvent(e);
  if (!step) return;
  const editable = isEditableTarget(e.target);
  const live = bindings.filter((b) => eligible(b, editable));

  const tryWith = (candidate: string[]): 'fired' | 'prefix' | 'none' => {
    for (let i = live.length - 1; i >= 0; i--) {
      const b = live[i]!;
      if (b.steps.length === candidate.length && startsWith(b.steps, candidate)) {
        if (b.options().preventDefault !== false) e.preventDefault();
        resetBuffer();
        const result = b.handler()(e);
        // A handler may return false to decline, letting lower-priority bindings run.
        if (result === false) continue;
        return 'fired';
      }
    }
    if (live.some((b) => b.steps.length > candidate.length && startsWith(b.steps, candidate))) {
      return 'prefix';
    }
    return 'none';
  };

  let outcome = tryWith([...buffer, step]);
  if (outcome === 'none' && buffer.length > 0) {
    resetBuffer();
    outcome = tryWith([step]);
  }
  if (outcome === 'prefix') {
    buffer = [...buffer, step];
    if (bufferTimer) clearTimeout(bufferTimer);
    bufferTimer = setTimeout(resetBuffer, SEQUENCE_TIMEOUT_MS);
  } else if (outcome === 'none') {
    resetBuffer();
  }
}

function ensureListener() {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  document.addEventListener('keydown', onKeyDown);
}

/** Register global hotkeys for the lifetime of the calling component. */
export function useHotkeys(map: Record<string, HotkeyHandler>, options: HotkeyOptions = {}): void {
  const mapRef = useRef(map);
  const optionsRef = useRef(options);
  mapRef.current = map;
  optionsRef.current = options;
  const keys = Object.keys(map).join('\n');
  const enabled = options.enabled !== false;

  // Bindings register when enabled, so the most recently opened overlay has priority.
  useEffect(() => {
    if (!enabled) return;
    ensureListener();
    const mac = isMac();
    const mine: Binding[] = keys
      .split('\n')
      .filter(Boolean)
      .map((spec) => {
        const steps = spec.split(/\s+/).map((s) => canonicalStep(s, mac));
        const first = steps[0] ?? '';
        return {
          steps,
          handler: () => (e) => mapRef.current[spec]?.(e),
          options: () => optionsRef.current,
          alwaysInInput: steps.length === 1 && /^(?:.*\+)?(ctrl|meta|alt)\+|^escape$/.test(first),
        };
      });
    bindings.push(...mine);
    return () => {
      for (const b of mine) {
        const i = bindings.indexOf(b);
        if (i >= 0) bindings.splice(i, 1);
      }
    };
  }, [keys, enabled]);
}

/* ---- Display ---- */

const DISPLAY_MAC: Record<string, string> = { ctrl: '⌃', alt: '⌥', meta: '⌘', shift: '⇧' };
const DISPLAY_OTHER: Record<string, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  meta: 'Win',
  shift: 'Shift',
};
const KEY_LABELS: Record<string, string> = {
  enter: '↵',
  escape: 'Esc',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  ' ': 'Space',
  backspace: '⌫',
  delete: 'Del',
  tab: 'Tab',
};

/**
 * Key labels for a shortcut spec, one array per step: `formatShortcut('mod+k')` is `[['Ctrl',
 * 'K']]` (or `[['⌘', 'K']]` on macOS); `'g b'` is `[['G'], ['B']]`.
 */
export function formatShortcut(spec: string, mac: boolean = isMac()): string[][] {
  return spec
    .trim()
    .split(/\s+/)
    .map((step) => {
      const canon = canonicalStep(step, mac).split('+');
      const key = canon.pop() ?? '';
      const label = KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
      const mods = canon.map((m) => (mac ? DISPLAY_MAC : DISPLAY_OTHER)[m] ?? m);
      return [...mods, label];
    });
}

/** Plain-text form for aria-keyshortcuts / tooltips: "Ctrl+K", "G then B". */
export function shortcutText(spec: string, mac: boolean = isMac()): string {
  return formatShortcut(spec, mac)
    .map((step) => step.join(mac ? '' : '+'))
    .join(' then ');
}
