'use client';

import { useMemo, useState } from 'react';
import {
  Box,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Focus,
  Layers,
  Maximize2,
} from 'lucide-react';
import { partLabel, type CadComponent } from '@/types/audit';

/**
 * Collapsible assembly navigator.
 *
 * A note on what this is and is not: `part_id` arrives as a *flat* list. STEP
 * ids are positional (`part_1`, `part_2`, …) and carry no parent/child data, so
 * there is no real assembly hierarchy to display. Grouping by `ifc_class` for
 * IFC input is a useful grouping of a flat list, not a reconstructed tree.
 * Presenting it as a true tree would be a lie about the data, so it is labelled
 * as a grouping and a single-component model renders as a plain list.
 */
export interface ModelTreeProps {
  components: CadComponent[];
  failedParts: string[];
  selectedPartId: string | null;
  hiddenParts: string[];
  isolatedPartId: string | null;
  onSelectPart: (partId: string | null) => void;
  onToggleVisibility: (partId: string) => void;
  onIsolate: (partId: string | null) => void;
  onShowAll: () => void;
  /**
   * Extra classes for the root section. The workbench docks this panel as a
   * full-height flex child, so it needs the caller to supply the height and
   * scrolling behaviour the old fixed `max-h` gave it.
   */
  className?: string;
  /** Whether the part list scrolls internally (`thin-scroll`) or the panel does. */
  scrollBody?: boolean;
}

function Group({
  label,
  count,
  children,
  defaultOpen = true,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <span className="truncate">{label}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] font-normal text-slate-400">
          {count}
        </span>
      </button>
      {open && <ul className="mt-0.5 space-y-0.5">{children}</ul>}
    </div>
  );
}

export default function ModelTree({
  components,
  failedParts,
  selectedPartId,
  hiddenParts,
  isolatedPartId,
  onSelectPart,
  onToggleVisibility,
  onIsolate,
  onShowAll,
  className = '',
  scrollBody = true,
}: ModelTreeProps) {
  const failed = useMemo(
    () => new Set(failedParts.filter((id) => id && id !== 'assembly')),
    [failedParts],
  );
  const hidden = useMemo(() => new Set(hiddenParts), [hiddenParts]);

  /**
   * Group by IFC class when the model actually carries one, otherwise keep a
   * single flat group. `components` order is the measured order, which is what
   * `part_N` numbering follows, so preserving it keeps the tree aligned with
   * the checklist and the viewer.
   */
  const groups = useMemo(() => {
    const hasClassification = components.some((component) => component.ifc_class);
    if (!hasClassification || components.length <= 1) {
      return [{ key: 'all', label: 'Components', items: components }];
    }

    const byClass = new Map<string, CadComponent[]>();
    for (const component of components) {
      const key = component.ifc_class ?? 'Unclassified';
      const bucket = byClass.get(key);
      if (bucket) bucket.push(component);
      else byClass.set(key, [component]);
    }
    return [...byClass.entries()].map(([key, items]) => ({ key, label: key, items }));
  }, [components]);

  const anyHidden = hidden.size > 0 || isolatedPartId !== null;

  return (
    <section
      className={'rounded-xl border border-slate-200 bg-white shadow-sm ' + className}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Layers className="h-4 w-4 text-slate-400" />
          Model Tree
        </h2>
        {anyHidden && (
          <button
            type="button"
            onClick={onShowAll}
            className="text-xs font-medium text-blue-700 transition hover:text-blue-900"
          >
            Show all
          </button>
        )}
      </div>

      <div
        className={
          'space-y-1.5 pr-1 ' +
          (scrollBody ? 'thin-scroll max-h-[320px] overflow-y-auto' : 'min-h-0 flex-1 overflow-y-auto')
        }
      >
        {groups.map((group) => (
          <Group
            key={group.key}
            label={group.label}
            count={group.items.length}
            defaultOpen={groups.length === 1 || group.items.length <= 12}
          >
            {group.items.map((component) => {
              const partId = component.part_id;
              const isFailed = failed.has(partId);
              const isHidden = hidden.has(partId);
              const isIsolated = isolatedPartId === partId;
              const isSelected = selectedPartId === partId;
              const dims = component.dimensions_mm;

              return (
                <li
                  key={partId}
                  className={
                    'group flex items-center gap-1 rounded-md border px-1.5 py-1 transition ' +
                    (isSelected
                      ? 'border-blue-600/50 bg-blue-50 '
                      : isFailed
                        ? 'border-rose-600/25 bg-rose-50/60 hover:border-rose-600/40 '
                        : 'border-transparent hover:border-slate-200 hover:bg-slate-50 ') +
                    (isHidden ? 'opacity-45' : '')
                  }
                >
                  <button
                    type="button"
                    onClick={() => onSelectPart(isSelected ? null : partId)}
                    title={partId}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span
                      aria-hidden
                      className={
                        'h-2 w-2 shrink-0 rounded-sm ' +
                        (isFailed ? 'bg-rose-600' : 'bg-slate-400')
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-slate-800">
                        {partLabel(partId)}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-slate-400">
                        {dims.length_x.toFixed(1)} x {dims.width_y.toFixed(1)} x{' '}
                        {dims.height_z.toFixed(1)} mm
                        {component.material ? ` · ${component.material}` : ''}
                      </span>
                    </span>
                  </button>

                  {isFailed && (
                    <span className="shrink-0 rounded bg-rose-50 px-1 py-0.5 text-[9px] font-bold text-rose-700 ring-1 ring-rose-600/20">
                      FAIL
                    </span>
                  )}

                  <button
                    type="button"
                    onClick={() => onToggleVisibility(partId)}
                    aria-label={isHidden ? `Show ${partId}` : `Hide ${partId}`}
                    title={isHidden ? 'Show' : 'Hide'}
                    className="shrink-0 rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                  >
                    {isHidden ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => onIsolate(isIsolated ? null : partId)}
                    aria-label={isIsolated ? 'Stop isolating' : `Isolate ${partId}`}
                    title={isIsolated ? 'Stop isolating' : 'Isolate'}
                    className={
                      'shrink-0 rounded p-1 transition hover:bg-slate-100 ' +
                      (isIsolated ? 'text-blue-700' : 'text-slate-400 hover:text-slate-700')
                    }
                  >
                    {isIsolated ? (
                      <Maximize2 className="h-3.5 w-3.5" />
                    ) : (
                      <Focus className="h-3.5 w-3.5" />
                    )}
                  </button>
                </li>
              );
            })}
          </Group>
        ))}
      </div>

      {components.length === 0 && (
        <p className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          <Box className="h-3.5 w-3.5 shrink-0" />
          No measurable solids were found in this model.
        </p>
      )}
    </section>
  );
}
