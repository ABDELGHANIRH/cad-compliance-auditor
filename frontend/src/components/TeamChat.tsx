'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Send, Trash2, Users, X, Sparkles, UserPlus, Check, Copy, Bot } from 'lucide-react';
import type { Reviewer, ReviewComment, Viewpoint } from '@/types/audit';

interface AiMessage {
  id: string;
  sender: string;
  role: string;
  text: string;
  timestamp: string;
  isAi: boolean;
}

export default function TeamChat({
  comments,
  participants,
  reviewer,
  draft,
  activeFindings = [],
  onDraftChange,
  onPost,
  onDelete,
  onLook,
  onClose,
}: {
  comments: ReviewComment[];
  participants: string[];
  reviewer: Reviewer;
  draft: string;
  activeFindings?: any[];
  onDraftChange: (value: string) => void;
  onPost: (body: string) => void;
  onDelete: (id: string) => void;
  onLook: (viewpoint: Viewpoint) => void;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<'team' | 'ai'>('team');
  const [copied, setCopied] = useState(false);
  const [showInvite, setShowInvite] = useState(false);

  // AI Chat State
  const [aiDraft, setAiDraft] = useState('');
  const [isLoadingAi, setIsLoadingAi] = useState(false);
  const [aiMessages, setAiMessages] = useState<AiMessage[]>([
    {
      id: 'ai-init',
      sender: 'DeepSeek Copilot',
      role: 'CAD Auditor',
      text: 'Hello. I have loaded the active CAD clash data and engineering rules. Ask me about any interference, alignment, or recommended design fix.',
      timestamp: 'Just now',
      isAi: true,
    },
  ]);

  const listRef = useRef<HTMLDivElement>(null);
  const aiListRef = useRef<HTMLDivElement>(null);
  const seen = useRef(comments.length);

  useEffect(() => {
    if (comments.length > seen.current) {
      listRef.current?.scrollTo?.({ top: listRef.current.scrollHeight, behavior: 'smooth' });
    }
    seen.current = comments.length;
  }, [comments.length]);

  useEffect(() => {
    aiListRef.current?.scrollTo?.({ top: aiListRef.current.scrollHeight, behavior: 'smooth' });
  }, [aiMessages]);

  const [value, setValue] = useState(draft);
  useEffect(() => setValue(draft), [draft]);

  const canPostTeam = value.trim().length > 0;
  const canPostAi = aiDraft.trim().length > 0;

  const submitTeam = () => {
    if (!canPostTeam) return;
    onPost(value.trim());
    setValue('');
    onDraftChange('');
  };

  const submitAi = async () => {
    if (!canPostAi || isLoadingAi) return;

    const userText = aiDraft.trim();
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const userMsg: AiMessage = {
      id: Date.now().toString(),
      sender: reviewer.name,
      role: reviewer.role || 'Engineer',
      text: userText,
      timestamp: timeStr,
      isAi: false,
    };

    const newHistory = [...aiMessages, userMsg];
    setAiMessages(newHistory);
    setAiDraft('');
    setIsLoadingAi(true);

    try {
      const payloadMessages = newHistory.map((m) => ({
        role: m.isAi ? 'assistant' : 'user',
        content: m.text,
      }));

      const res = await fetch('/api/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: payloadMessages,
          currentAuditFindings: activeFindings,
        }),
      });

      const data = await res.json();
      setAiMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          sender: 'DeepSeek Copilot',
          role: 'CAD Auditor',
          text: data.reply || 'No analysis returned from copilot.',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          isAi: true,
        },
      ]);
    } catch {
      setAiMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          sender: 'DeepSeek Copilot',
          role: 'System',
          text: 'Unable to connect to DeepSeek API. Please verify your DEEPSEEK_API_KEY.',
          timestamp: timeStr,
          isAi: true,
        },
      ]);
    } finally {
      setIsLoadingAi(false);
    }
  };

  const copySessionLink = () => {
    const url = `${window.location.origin}${window.location.pathname}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {/* ----------------- Top Header & Segmented Switcher ----------------- */}
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 p-2.5 bg-slate-50/70">
        <div className="flex items-center space-x-1 bg-slate-200/70 p-0.5 rounded-lg">
          <button
            type="button"
            onClick={() => setActiveTab('team')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition ${
              activeTab === 'team'
                ? 'bg-white text-slate-800 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Users className="h-3.5 w-3.5 text-blue-600" />
            <span>Team Stream</span>
            {participants.length > 0 && (
              <span className="ml-0.5 rounded-full bg-slate-100 px-1.5 py-0.2 text-[10px] text-slate-600">
                {participants.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('ai')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition ${
              activeTab === 'ai'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>Ask Copilot</span>
          </button>
        </div>

        <div className="flex items-center gap-1">
          {activeTab === 'team' && (
            <button
              type="button"
              onClick={() => setShowInvite((prev) => !prev)}
              aria-label="Invite team members"
              title="Invite to live session"
              className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-blue-600 transition"
            >
              <UserPlus className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Invite Popover */}
      {showInvite && activeTab === 'team' && (
        <div className="border-b border-blue-200 bg-blue-50/80 p-2.5 text-xs">
          <p className="font-semibold text-blue-900 mb-1">Live Multi-Tab Collaboration</p>
          <p className="text-blue-700 mb-2 text-[11px] leading-snug">
            Share this link to sync viewpoints and inspection comments live across browser sessions:
          </p>
          <button
            type="button"
            onClick={copySessionLink}
            className="w-full flex items-center justify-center gap-1.5 rounded-md bg-blue-600 py-1.5 px-2 text-xs font-medium text-white hover:bg-blue-700 transition"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? 'Link Copied!' : 'Copy Session Link'}</span>
          </button>
        </div>
      )}

      {/* -------------------- TAB 1: TEAM STREAM -------------------- */}
      {activeTab === 'team' && (
        <>
          <p className="shrink-0 border-b border-slate-100 bg-slate-50 px-3 py-1 text-[10px] text-slate-500">
            Real-time feed synced across tabs via BroadcastChannel.
          </p>

          <div ref={listRef} className="thin-scroll min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
            {comments.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-[11px] leading-relaxed text-slate-500">
                No team messages yet. Post a comment to discuss skid clashes or tag components.
              </p>
            ) : (
              comments.map((comment) => (
                <ChatMessage
                  key={comment.id}
                  comment={comment}
                  mine={comment.author === reviewer.name}
                  onDelete={() => onDelete(comment.id)}
                  onLook={comment.viewpoint ? () => onLook(comment.viewpoint as Viewpoint) : null}
                />
              ))
            )}
          </div>

          <div className="shrink-0 border-t border-slate-200 p-2.5">
            <div className="rounded-lg border border-slate-200 bg-white focus-within:border-blue-400">
              <textarea
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  onDraftChange(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submitTeam();
                  }
                }}
                rows={1}
                placeholder="Message team (e.g. check line A elbow clearance)..."
                className="block w-full resize-none bg-transparent px-2.5 py-2 text-xs text-slate-800 outline-none placeholder:text-slate-400"
              />
              <div className="flex items-center gap-2 px-2.5 pb-2">
                <span className="min-w-0 flex-1 truncate text-[10px] text-slate-400">
                  {reviewer.name} · {reviewer.role}
                </span>
                <button
                  type="button"
                  onClick={submitTeam}
                  disabled={!canPostTeam}
                  className={`flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition ${
                    canPostTeam
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'cursor-not-allowed bg-slate-100 text-slate-400'
                  }`}
                >
                  <Send className="h-3 w-3" />
                  Send
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* -------------------- TAB 2: ASK DEEPSEEK COPILOT -------------------- */}
      {activeTab === 'ai' && (
        <>
          <p className="shrink-0 border-b border-indigo-100 bg-indigo-50/50 px-3 py-1 text-[10px] text-indigo-700">
            Grounding: CAD Clash JSON + Clearance Specifications.
          </p>

          <div ref={aiListRef} className="thin-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {aiMessages.map((msg) => (
              <div key={msg.id} className="flex gap-2">
                <span
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${
                    msg.isAi ? 'bg-indigo-600' : 'bg-slate-700'
                  }`}
                >
                  {msg.isAi ? <Bot className="h-3.5 w-3.5" /> : msg.sender.charAt(0)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[11px] font-semibold text-slate-800">{msg.sender}</span>
                    <span className="text-[10px] text-slate-400">{msg.timestamp}</span>
                  </div>
                  <div
                    className={`mt-1 rounded-lg px-2.5 py-1.5 text-xs leading-relaxed ${
                      msg.isAi
                        ? 'bg-indigo-50/70 border border-indigo-100 text-indigo-950'
                        : 'bg-white border border-slate-200 text-slate-800'
                    }`}
                  >
                    {msg.text}
                  </div>
                </div>
              </div>
            ))}
            {isLoadingAi && (
              <div className="flex items-center gap-2 text-indigo-600 text-xs py-1">
                <Sparkles className="h-3.5 w-3.5 animate-spin" />
                <span>Evaluating geometric clearances...</span>
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-slate-200 p-2.5">
            <div className="rounded-lg border border-slate-200 bg-white focus-within:border-indigo-400">
              <textarea
                value={aiDraft}
                onChange={(e) => setAiDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submitAi();
                  }
                }}
                rows={1}
                placeholder="Ask about clashes, holes, or alignments..."
                className="block w-full resize-none bg-transparent px-2.5 py-2 text-xs text-slate-800 outline-none placeholder:text-slate-400"
              />
              <div className="flex items-center justify-end px-2.5 pb-2">
                <button
                  type="button"
                  onClick={submitAi}
                  disabled={!canPostAi || isLoadingAi}
                  className={`flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition ${
                    canPostAi && !isLoadingAi
                      ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                      : 'cursor-not-allowed bg-slate-100 text-slate-400'
                  }`}
                >
                  <Sparkles className="h-3 w-3" />
                  Ask AI
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ChatMessage({
  comment,
  mine,
  onDelete,
  onLook,
}: {
  comment: ReviewComment;
  mine: boolean;
  onDelete: () => void;
  onLook: (() => void) | null;
}) {
  const when = useMemo(() => relativeTime(comment.createdAt), [comment.createdAt]);

  return (
    <div className="group flex gap-2">
      <span
        aria-hidden
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[10px] font-bold uppercase text-slate-600"
      >
        {comment.author.trim().charAt(0) || '?'}
      </span>

      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-1.5">
          <span className="truncate text-[11px] font-semibold text-slate-800">
            {comment.author}
          </span>
          {comment.role && (
            <span className="truncate text-[10px] text-slate-500">({comment.role})</span>
          )}
          <span className="ml-auto shrink-0 text-[10px] text-slate-400">{when}</span>
        </p>

        <p className="mt-0.5 whitespace-pre-wrap break-words rounded-lg rounded-tl-none bg-white px-2.5 py-1.5 text-[11px] leading-relaxed text-slate-700 ring-1 ring-slate-200">
          {comment.body}
        </p>

        <div className="mt-0.5 flex items-center gap-2 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
          {onLook && (
            <button
              type="button"
              onClick={onLook}
              className="text-[10px] font-medium text-blue-700 transition hover:text-blue-900"
            >
              Look at this view
            </button>
          )}
          {mine && (
            <button
              type="button"
              onClick={onDelete}
              className="flex items-center gap-0.5 text-[10px] text-slate-400 transition hover:text-rose-600"
            >
              <Trash2 className="h-2.5 w-2.5" />
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function relativeTime(iso: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}