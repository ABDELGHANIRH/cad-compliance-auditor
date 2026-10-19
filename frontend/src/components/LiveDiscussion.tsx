'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, ChevronRight, MessageSquare, Plus, Send, Trash2, Users } from 'lucide-react';
import {
  DISCUSSION_ROLES,
  initials,
  roleShortLabel,
  type Reviewer,
  type ReviewComment,
  type Viewpoint,
} from '@/types/audit';
import { clockTime, fullTime } from '@/lib/review';

/**
 * The colour of one role's badge.
 *
 * Keyed by role string rather than by an index into `DISCUSSION_ROLES`,
 * because the comments being rendered were not necessarily written by the
 * locally selected identity - a thread synced from another tab carries whatever
 * role that tab was posting as, and the badge has to colour that role, not the
 * reader's.
 *
 * Each tone is a matched pair on a light tint so the badge stays legible
 * without a filled pill: the card already spends its colour budget on the
 * status pill and the author's identity is not a verdict.
 */
const ROLE_TONE: Record<string, string> = {
  'quality controller': 'border-emerald-200 bg-emerald-50 text-emerald-700',
  'piping engineer': 'border-blue-200 bg-blue-50 text-blue-700',
  'electrical engineer': 'border-amber-200 bg-amber-50 text-amber-700',
};

/** Neutral badge for a role this build does not know - a free-text one. */
const ROLE_TONE_FALLBACK = 'border-slate-200 bg-slate-50 text-slate-600';

/** The avatar colour per role, so a thread reads by discipline at a glance. */
const ROLE_AVATAR: Record<string, string> = {
  'quality controller': 'bg-emerald-600',
  'piping engineer': 'bg-blue-600',
  'electrical engineer': 'bg-amber-600',
};

/** Round avatar carrying the author's initials, tinted by their discipline. */
function Avatar({ name, role }: { name: string; role: string }) {
  const tone = ROLE_AVATAR[role.trim().toLowerCase()] ?? 'bg-slate-500';
  return (
    <span
      aria-hidden
      title={name}
      className={
        'flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-full text-[9px] font-bold tracking-tight text-white ring-2 ring-white ' +
        tone
      }
    >
      {initials(name)}
    </span>
  );
}

/** The role badge beside an author's name, coloured by discipline. */
function RoleBadge({ role }: { role: string }) {
  const tone = ROLE_TONE[role.trim().toLowerCase()] ?? ROLE_TONE_FALLBACK;
  return (
    <span
      title={role}
      className={
        'shrink-0 rounded border px-1.5 py-px text-[10px] font-medium ' + tone
      }
    >
      {roleShortLabel(role)}
    </span>
  );
}

/**
 * The role switcher for the demo's multi-user session.
 *
 * A native `<select>` rather than a custom popover menu: this is a testing
 * affordance sitting at the bottom of a dock, it must not steal focus or
 * swallow a click meant for the composer, and a native control is keyboard- and
 * screen-reader-correct for free.
 *
 * The currently stored role is added to the list when it is not one of the
 * three, so a reviewer who set a custom role in the identity dialog can see
 * which identity they hold and get back to it after switching away.
 */
function RoleSwitcher({
  role,
  onChange,
}: {
  role: string;
  onChange: (role: string) => void;
}) {
  const known = DISCUSSION_ROLES.includes(role as (typeof DISCUSSION_ROLES)[number]);
  const options = useMemo(
    () =>
      known
        ? [...DISCUSSION_ROLES]
        : [role, ...DISCUSSION_ROLES].filter((entry) => entry.trim().length > 0),
    [known, role],
  );

  return (
    <label className="flex min-w-0 items-center gap-1.5">
      <Users className="h-3 w-3 shrink-0 text-slate-400" aria-hidden />
      <span className="sr-only">Active identity</span>
      <select
        value={role}
        onChange={(event) => onChange(event.target.value)}
        title="Switch the identity you are posting as - open a second window to act as another discipline"
        className={
          'min-w-0 max-w-[11rem] truncate rounded-md border border-slate-300 bg-white py-0.5 pl-1.5 pr-6 text-[10px] font-medium text-slate-700 transition hover:border-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600 ' +
          // The select is styled to read as a chip, so the native caret is the
          // only affordance left saying it is interactive. Kept, rather than
          // replaced with a background-image arrow, so the control stays a real
          // select in every browser and at every zoom level.
          'appearance-none bg-[length:12px] bg-[right_0.35rem_center] bg-no-repeat'
        }
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none' stroke='%2364748b' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 4.5 6 7.5 9 4.5'/%3E%3C/svg%3E\")",
        }}
      >
        {options.map((entry) => (
          <option key={entry} value={entry}>
            {entry}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * One message bubble.
 *
 * Own message or someone else's, rather than left/right alignment. This dock
 * sits in a 460 px panel inside a workbench, not in a phone chat: a
 * right-aligned bubble column would double the ragged edge for no gain, and the
 * author's own message is already distinguished by the accent border and the
 * fact that only it carries a delete control.
 */
function MessageBubble({
  comment,
  mine,
  onLook,
  onDelete,
}: {
  comment: ReviewComment;
  mine: boolean;
  onLook: (viewpoint: Viewpoint) => void;
  onDelete: () => void;
}) {
  const viewpoint = comment.viewpoint;

  return (
    <div className="flex items-start gap-2">
      <Avatar name={comment.author} role={comment.role} />
      <div
        className={
          'min-w-0 flex-1 rounded-lg border bg-white px-2 py-1.5 ' +
          (mine ? 'border-blue-200 ring-1 ring-blue-100' : 'border-slate-200')
        }
      >
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="text-[11px] font-semibold text-slate-800">
            {comment.author}
          </span>
          <RoleBadge role={comment.role} />
          <span
            className="ml-auto shrink-0 text-[10px] tabular-nums text-slate-400"
            title={fullTime(comment.createdAt)}
          >
            {clockTime(comment.createdAt)}
          </span>
        </div>

        <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-700">
          {comment.body}
        </p>

        {/* The message's footer carries at most two quiet controls. Neither is
            rendered when it would do nothing: a comment with no captured pose
            has nothing to look at, and only the author's own message can be
            deleted. */}
        {(viewpoint || mine) && (
          <div className="mt-1 flex items-center gap-2">
            {viewpoint && (
              <button
                type="button"
                onClick={() => onLook(viewpoint)}
                title="Fly the 3D camera to the angle this comment was written from"
                className="flex items-center gap-1 rounded text-[10px] font-medium text-slate-500 transition hover:text-blue-700"
              >
                <Camera className="h-3 w-3 shrink-0" aria-hidden />
                Look at this view
              </button>
            )}
            {mine && (
              <button
                type="button"
                aria-label="Delete comment"
                onClick={onDelete}
                className="ml-auto shrink-0 rounded p-0.5 text-slate-300 transition hover:bg-slate-100 hover:text-rose-700"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The multi-user discussion thread attached to one finding.
 *
 * Presented as a conversation feed rather than as a list of review notes: an
 * author with a discipline badge and a wall-clock time, a bubble you can reply
 * into, and - the part that makes this a QC tool rather than a chat - a
 * "Look at this view" control that flies another user's camera to the exact
 * angle the comment was written from.
 *
 * Lifted out of `FindingCard` because the card's thread was already a
 * self-contained feed with its own composer, disclosure state and identity
 * footer. Keeping it there would have meant threading four more props and a
 * camera callback through a component whose job is to render a finding.
 *
 * The thread does not own the messages. They live in the workbench's
 * `CommentMap`, keyed by check identity, and are persisted and broadcast from
 * there - see `useDiscuss`. This component is the view over one finding's slice
 * of it.
 */
export default function LiveDiscussion({
  comments,
  roster,
  reviewer,
  draft,
  onDraftChange,
  onPost,
  onDelete,
  onLook,
  onRoleChange,
}: {
  comments: ReviewComment[];
  /**
   * Every name seen in the discussion so far, for the participation count.
   *
   * Passed in rather than derived from `comments`, which only holds the thread
   * for this one finding - a count of "3 people" computed from one finding's
   * messages would drop anyone who has only spoken on another.
   */
  roster: string[];
  reviewer: Reviewer;
  draft: string;
  onDraftChange: (value: string) => void;
  onPost: (body: string) => void;
  onDelete: (id: string) => void;
  onLook: (viewpoint: Viewpoint) => void;
  /** Switch the identity this client posts as. */
  onRoleChange: (role: string) => void;
}) {
  /** The composer is behind a link until it is wanted. */
  const [composerOpen, setComposerOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  /** How many messages were on screen at the last render, to detect an arrival. */
  const seen = useRef(comments.length);

  /**
   * Keep the newest message in view.
   *
   * Only when the thread grew, so the list is not yanked to the bottom under a
   * reader who has scrolled up to re-read the earlier part of an argument. A
   * message arriving from the other browser tab is the case this exists for:
   * without it, a live reply lands silently below the fold.
   */
  useEffect(() => {
    if (comments.length > seen.current) {
      const node = listRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    }
    seen.current = comments.length;
  }, [comments.length]);

  const submit = useCallback(() => {
    const body = draft.trim();
    if (!body) return;
    onPost(body);
    onDraftChange('');
  }, [draft, onPost, onDraftChange]);

  const myName = reviewer.name.trim().toLowerCase();
  const others = roster.filter((name) => name.trim().toLowerCase() !== myName).length;

  return (
    <div className="space-y-2">
      {/* ------------------------------ Feed ------------------------------ */}
      {comments.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 px-2 py-2 text-center text-[10px] leading-relaxed text-slate-400">
          No discussion yet. Comments here are shared with every discipline
          reviewing this model.
        </p>
      ) : (
        <div
          ref={listRef}
          className="thin-scroll max-h-72 space-y-1.5 overflow-y-auto pr-0.5"
        >
          {comments.map((comment) => (
            <MessageBubble
              key={comment.id}
              comment={comment}
              // Case-insensitive: a name is typed into a settings field, and
              // "sam okoro" and "Sam Okoro" are the same person.
              mine={comment.author.trim().toLowerCase() === myName}
              onLook={onLook}
              onDelete={() => onDelete(comment.id)}
            />
          ))}
        </div>
      )}

      {/* ---------------------------- Composer ---------------------------- */}
      {composerOpen || draft.trim().length > 0 ? (
        <div className="flex items-start gap-2">
          <Avatar name={reviewer.name} role={reviewer.role} />
          <div className="min-w-0 flex-1">
            <textarea
              value={draft}
              autoFocus
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends, Shift+Enter breaks the line. Checked against
                // `isComposing` so an Enter that commits an IME candidate does
                // not also post a half-typed message.
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
              rows={draft.split('\n').length > 1 ? 2 : 1}
              placeholder="Reply to the thread… (Enter to send, Shift+Enter for a new line)"
              aria-label="Reply to the discussion"
              className="thin-scroll w-full resize-y rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs leading-relaxed text-slate-800 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600"
            />
            <div className="mt-1 flex items-center gap-2">
              {/* What the comment will actually carry: the pose is read from the
                  live camera at the moment of posting, so the only honest way to
                  advertise it is to say it will be attached. */}
              <span className="truncate text-[10px] text-slate-400">
                Posting as {reviewer.name} · current view will be attached
              </span>
              <button
                type="button"
                onClick={submit}
                disabled={!draft.trim()}
                className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full bg-blue-800 px-2.5 py-1 text-[10px] font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
              >
                <Send className="h-3 w-3" aria-hidden />
                Post
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setComposerOpen(true)}
          className="flex items-center gap-1.5 px-1 py-0.5 text-[10px] font-medium text-slate-500 transition hover:text-blue-700"
        >
          <Plus className="h-3 w-3" aria-hidden />
          Add a comment…
        </button>
      )}

      {/* ------------------------------ Footer -----------------------------
          The demo's role switch, and the state a real multi-user session would
          otherwise leave invisible: who else is in this thread. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-100 pt-1.5">
        <RoleSwitcher role={reviewer.role} onChange={onRoleChange} />
        {others > 0 ? (
          <span className="flex items-center gap-1 text-[10px] text-slate-400">
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full bg-emerald-500"
            />
            {others} other{others === 1 ? '' : 's'} in this thread
          </span>
        ) : (
          <span className="text-[10px] text-slate-400">
            Open a second window to join as another discipline
          </span>
        )}
      </div>
    </div>
  );
}

/** The disclosure row above the thread, so the dock stays compact by default. */
export function DiscussionSummary({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition hover:bg-slate-50"
    >
      <MessageSquare className="h-3 w-3 shrink-0 text-slate-400" aria-hidden />
      <span className="text-[10px] font-medium text-slate-500">
        {count > 0
          ? `${count} message${count === 1 ? '' : 's'}`
          : open
            ? 'Discussion'
            : '+ Add comment'}
      </span>
      <ChevronRight
        aria-hidden
        className={
          'h-3 w-3 shrink-0 text-slate-400 transition-transform ' +
          (open ? 'rotate-90' : '')
        }
      />
    </button>
  );
}
