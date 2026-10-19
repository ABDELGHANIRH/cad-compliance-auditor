'use client';

import { useEffect, useState } from 'react';
import { UserRound, X } from 'lucide-react';
import { DEFAULT_REVIEWER, initials, type Reviewer } from '@/types/audit';

/**
 * Set the name and role that appear on review comments.
 *
 * A modal rather than an inline field: the identity is set once and then applies
 * to everything, so it does not belong in the comment composer where it would
 * read as a per-comment field. Kept deliberately small - it is a display name
 * for a single-user tool, not an account.
 *
 * Mounted only while open (the caller renders it conditionally), so the fields
 * start from the current reviewer on every open and a cancelled edit leaves
 * nothing behind. `open` is accepted only so the caller can pass one flag to
 * both this and its own conditional; it is not a visibility toggle.
 */
export default function ReviewerSettings({
  reviewer,
  onSave,
  onClose,
}: {
  reviewer: Reviewer;
  onSave: (reviewer: Reviewer) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(reviewer.name);
  const [role, setRole] = useState(reviewer.role);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const canSave = name.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reviewer-settings-title"
        onClick={(event) => event.stopPropagation()}
        className="animate-fade-in w-full max-w-sm overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/20"
      >
        <div className="flex items-center gap-2.5 border-b border-slate-200 p-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600">
            <UserRound className="h-3.5 w-3.5" />
          </span>
          <h2
            id="reviewer-settings-title"
            className="flex-1 text-sm font-semibold text-slate-900"
          >
            Your reviewer identity
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-3">
          <p className="text-[11px] leading-relaxed text-slate-500">
            Comments you post are stamped with this name and role, in the review
            stream and in the exported report.
          </p>

          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Name
            </span>
            <input
              type="text"
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              placeholder={DEFAULT_REVIEWER.name}
              className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Role
            </span>
            <input
              type="text"
              value={role}
              onChange={(event) => setRole(event.target.value)}
              placeholder={DEFAULT_REVIEWER.role}
              className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600"
            />
          </label>

          {/* Live preview of the avatar the comments will carry. */}
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-teal-600 text-[10px] font-bold text-white ring-2 ring-white">
              {initials(name || DEFAULT_REVIEWER.name)}
            </span>
            <span className="min-w-0 truncate text-[11px] text-slate-700">
              {name.trim() || DEFAULT_REVIEWER.name}
            </span>
            <span className="shrink-0 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
              {role.trim() || DEFAULT_REVIEWER.role}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-slate-200 bg-slate-50 p-3">
          <button
            type="button"
            onClick={() => {
              setName(DEFAULT_REVIEWER.name);
              setRole(DEFAULT_REVIEWER.role);
            }}
            className="rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-slate-500 transition hover:bg-slate-200 hover:text-slate-800"
          >
            Reset to default
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => {
              onSave({
                name: name.trim() || DEFAULT_REVIEWER.name,
                role: role.trim() || DEFAULT_REVIEWER.role,
              });
              onClose();
            }}
            className="ml-auto rounded-lg bg-blue-800 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
