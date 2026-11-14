import {
  SEARCH_ENGINE_PRESETS,
  buildSearchUrl,
  coreSettings,
  validateSearchTemplate,
} from '@webfront/shared';
import { useEffect, useState } from 'react';
import { Button, Field, Input, Select } from '@/ui';
import { useSetting } from './useSetting';

const CUSTOM = '__custom';

export default function SearchSection() {
  const [engine, setEngine] = useSetting(coreSettings.searchEngine);
  const preset = SEARCH_ENGINE_PRESETS.find((p) => p.urlTemplate === engine.urlTemplate);
  const [custom, setCustom] = useState(!preset);
  const [name, setName] = useState(engine.name);
  const [template, setTemplate] = useState(engine.urlTemplate);
  useEffect(() => {
    setName(engine.name);
    setTemplate(engine.urlTemplate);
    setCustom(!SEARCH_ENGINE_PRESETS.some((p) => p.urlTemplate === engine.urlTemplate));
  }, [engine.name, engine.urlTemplate]);

  const error = custom ? validateSearchTemplate(template) : null;
  const nameError = custom && !name.trim() ? 'Enter a name.' : null;

  return (
    <div className="flex max-w-xl flex-col gap-2 text-sm">
      <Field
        label="Web search engine"
        hint="Used when nothing on your pages matches, or with Ctrl/Cmd+Enter."
      >
        {(p) => (
          <Select
            {...p}
            value={custom ? CUSTOM : (preset?.name ?? CUSTOM)}
            onChange={(e) => {
              if (e.target.value === CUSTOM) return setCustom(true);
              const chosen = SEARCH_ENGINE_PRESETS.find((x) => x.name === e.target.value);
              if (chosen) {
                setCustom(false);
                void setEngine({ name: chosen.name, urlTemplate: chosen.urlTemplate });
              }
            }}
          >
            {SEARCH_ENGINE_PRESETS.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
            <option value={CUSTOM}>Custom…</option>
          </Select>
        )}
      </Field>
      {custom && (
        <>
          <Field label="Name" error={nameError}>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Search URL" hint="Use %s where the search text goes." error={error}>
            {(p) => (
              <Input
                {...p}
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                placeholder="https://example.com/search?q=%s"
              />
            )}
          </Field>
          {!error && (
            <p className="break-all text-xs text-fg-3">
              Example: {buildSearchUrl(template, 'hello world')}
            </p>
          )}
          <div>
            <Button
              variant="primary"
              disabled={!!error || !!nameError}
              onClick={() => void setEngine({ name: name.trim(), urlTemplate: template.trim() })}
            >
              Save engine
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
