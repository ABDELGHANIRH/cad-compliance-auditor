"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import {
  AlertTriangle,
  CheckCircle2,
  CheckCheck,
  ChevronDown,
  Download,
  FileBox,
  Loader2,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Plus,
  Printer,
  Ruler,
  ScanSearch,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import {
  DEFAULT_REVIEWER,
  partLabel,
  type AuditResponse,
  type CheckItem,
  type CheckStatus,
  type CommentMap,
  type Decision,
  type DecisionMap,
  type DecisionVerdict,
  type DisciplineKey,
  type Reviewer,
  type ReviewComment,
  type ViewerAnnotation,
  type Viewpoint,
} from "@/types/audit";
import {
  clearDecisions,
  decisionKey,
  loadDecisions,
  reconcileDecisions,
  reviewProgress,
  saveDecisions,
  teamChannelKey,
} from "@/lib/decisions";
import {
  captureAnchor,
  captureViewpoint,
  clearComments,
  loadComments,
  loadReviewer,
  makeId,
  reconcileComments,
  saveComments,
  saveReviewer,
} from "@/lib/review";
import {
  commentAnnotations,
  groupAnnotations,
  type AnnotationStack,
} from "@/lib/annotations";
import {
  buildReport,
  downloadJson,
  reportFileName,
  reportToJson,
  unreviewedFindings,
} from "@/lib/report";
import ReviewerSettings from "@/components/ReviewerSettings";
import TeamChat from "@/components/TeamChat";
import type { CameraFocusRequest } from "@/components/CADViewer";

// ---------------------------------------------------------------------------
// Cross-tab collaboration
// ---------------------------------------------------------------------------

/**
 * The channel every tab of this app joins.
 *
 * Fixed rather than per-audit: a reviewer opens the second window while the
 * first is already sitting on a response, so the two tabs have no other
 * rendezvous point than the name itself. `BroadcastChannel` is scoped to the
 * origin, so this cannot collide with another deployment or another site.
 */
const COLLAB_CHANNEL = "bim_qc_collaboration";

/** The events a tab publishes. One union, so the receiver's switch is exhaustive. */
type CollaborationEvent =
  | { type: "comments"; threadKey: string; thread: ReviewComment[] }
  | { type: "decision"; threadKey: string; decision: Decision | null };

/**
 * One message on the wire. `sender` is this tab's id, which is what makes the
 * echo guard possible: a channel does not deliver to the tab that posted, but
 * the same tab can hold more than one channel (a remount, React strict mode in
 * development), and the last thing this app should do is apply its own message
 * twice.
 */
interface CollaborationMessage {
  sender: string;
  event: CollaborationEvent;
}

/** This tab's identity, for the echo guard. `null` until a browser has one. */
let tabId: string | null = null;

function currentTabId(): string {
  if (!tabId) tabId = makeId();
  return tabId;
}

/** The open channel, held so both the publisher and the listener reach the same one. */
let channel: BroadcastChannel | null = null;

/**
 * Join the collaboration channel, once per tab.
 *
 * `BroadcastChannel` is absent on older Safari and undefined during the server
 * render of this client component, so every path here degrades to "this tab
 * works alone" rather than throwing.
 */
function collaborationChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined")
    return null;
  if (!channel) channel = new BroadcastChannel(COLLAB_CHANNEL);
  return channel;
}

/** Send one event to the other tabs. A dead channel must not break the local edit. */
function broadcast(event: CollaborationEvent): void {
  try {
    collaborationChannel()?.postMessage({ sender: currentTabId(), event });
  } catch {
    // A channel can be closed under us by a reload; the local state is already
    // updated and the persistent copy is in localStorage, so this is not fatal.
  }
}

/**
 * Read a message off the wire, or null when it is not one of ours.
 *
 * A receiving tab must treat this as untrusted input: the payload arrives as
 * `unknown`, from a channel any script on the origin can post to. Every field
 * is checked before it reaches state, and a malformed message is dropped
 * rather than allowed to blank a thread.
 */
function readCollaborationMessage(data: unknown): CollaborationEvent | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Partial<CollaborationMessage>;
  // Our own message, arriving on a second channel this tab happens to hold.
  if (message.sender === currentTabId()) return null;

  const event = message.event as Partial<CollaborationEvent> | undefined;
  if (!event || typeof event !== "object") return null;
  if (typeof event.threadKey !== "string" || !event.threadKey) return null;

  if (event.type === "comments") {
    if (!Array.isArray(event.thread)) return null;
    const thread: ReviewComment[] = [];
    for (const entry of event.thread) {
      if (!entry || typeof entry !== "object") return null;
      const candidate = entry as Partial<ReviewComment>;
      if (typeof candidate.id !== "string" || !candidate.id) return null;
      thread.push({
        id: candidate.id,
        author:
          typeof candidate.author === "string"
            ? candidate.author
            : DEFAULT_REVIEWER.name,
        role:
          typeof candidate.role === "string"
            ? candidate.role
            : DEFAULT_REVIEWER.role,
        body: typeof candidate.body === "string" ? candidate.body : "",
        createdAt:
          typeof candidate.createdAt === "string" ? candidate.createdAt : "",
        // Rebuilt field by field rather than trusted wholesale. A pose that is
        // not three finite numbers would fly this tab's camera to NaN, and the
        // failure would surface as a blank viewport rather than as a bad payload.
        viewpoint: readWireViewpoint(candidate.viewpoint),
        // And the anchor, held to the same standard: it steers a camera too,
        // when the cloud over the model is clicked.
        anchor: readWireAnchor(candidate.anchor),
      });
    }
    return { type: "comments", threadKey: event.threadKey, thread };
  }

  if (event.type === "decision") {
    const decision = event.decision;
    if (decision === null || decision === undefined) {
      return { type: "decision", threadKey: event.threadKey, decision: null };
    }
    if (typeof decision !== "object") return null;
    const candidate = decision as Partial<Decision>;
    if (
      candidate.verdict !== "accepted" &&
      candidate.verdict !== "rejected" &&
      candidate.verdict !== "modified"
    ) {
      return null;
    }
    return {
      type: "decision",
      threadKey: event.threadKey,
      decision: {
        verdict: candidate.verdict,
        notes: typeof candidate.notes === "string" ? candidate.notes : "",
        decidedAt:
          typeof candidate.decidedAt === "string" ? candidate.decidedAt : "",
      },
    };
  }

  return null;
}

/** Validate a viewpoint that arrived over the channel; drop it if it is not a pose. */
function readWireViewpoint(value: unknown): Viewpoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { position?: unknown; target?: unknown };
  const position = wireTriple(candidate.position);
  const target = wireTriple(candidate.target);
  return position && target ? { position, target } : undefined;
}

function wireTriple(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
    return null;
  return [x, y, z];
}

/**
 * Validate an anchor that arrived over the channel; drop it if it is not a point.
 *
 * Softer than `readWireViewpoint`'s shape check in one respect and identical in
 * the important one: a malformed anchor does not reject the message, it only
 * costs that one comment its cloud. The comment's words are still the comment,
 * and dropping a whole thread because another tab sent a bad coordinate would
 * lose real review work to a cosmetic failure.
 */
function readWireAnchor(value: unknown): [number, number, number] | undefined {
  if (value === undefined || value === null) return undefined;
  return wireTriple(value) ?? undefined;
}

const CADViewer = dynamic(() => import("@/components/CADViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-slate-100">
      <div className="flex flex-col items-center gap-2 text-slate-500">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span className="text-xs font-medium">Initialising 3D viewer</span>
      </div>
    </div>
  ),
});

const ModelTree = dynamic(() => import("@/components/ModelTree"), {
  ssr: false,
  loading: () => <div className="h-40 animate-pulse rounded-xl bg-slate-100" />,
});

const ReviewStream = dynamic(() => import("@/components/ReviewStream"), {
  ssr: false,
  loading: () => <div className="h-full animate-pulse bg-slate-50" />,
});

/**
 * The printable report is off-screen and only revealed by the print stylesheet
 * in globals.css, so it never needs interactivity - but it renders in the
 * browser either way.
 */
const AuditReport = dynamic(() => import("@/components/AuditReport"), {
  ssr: false,
});

/**
 * One-click presets. Each pairs the specification text with the model it is
 * written against, so a click produces a runnable audit rather than a
 * specification with nothing to check it against.
 *
 * The Skid spec is derived from sample_skid.ifc: the riser bore is modelled at
 * 90 mm, so a 100 mm requirement makes it fail while the DN32 branch (32 mm)
 * conforms - giving the demo a mixture of PASS and FAIL findings. The bracket
 * spec matches backend/make_sample.py, which models the base plate at 120 mm
 * so that a 145 mm requirement fails it.
 */
interface Preset {
  id: string;
  label: string;
  format: string;
  /** Same-origin path under public/samples. */
  url: string;
  fileName: string;
  spec: string;
}

const PRESETS: Preset[] = [
  {
    id: "skid",
    label: "Demo Skid (IFC)",
    format: "IFC4",
    url: "/samples/sample_skid.ifc",
    fileName: "sample_skid.ifc",
    spec: `Riser pipe must have an outer diameter of 100 mm.
Branch distribution line must have an outer diameter of 32 mm.
Elbow must measure 110 mm x 110 mm x 110 mm.
Isolation valve body must measure 90 mm x 120 mm x 90 mm.
Booster pump footprint must be 220 mm x 300 mm and 200 mm tall.
All linear dimensions carry a tolerance of +/- 1.0 mm.`,
  },
  {
    id: "bracket",
    label: "Sample Bracket (STEP)",
    format: "STEP",
    url: "/samples/test_scissor.step",
    fileName: "test_scissor.step",
    spec: `Base plate must be 145 mm long, 40 mm wide and 10 mm thick.
Mounting post must be 25 mm x 25 mm x 60 mm.
All linear dimensions carry a tolerance of +/- 0.5 mm.`,
  },
];

/** How long the telemetry bar is given before it stops estimating. */
const WARMUP_MS = 20_000;
/**
 * The backend returns a single JSON body with no progress events, so the share
 * of the bar the deterministic stages are known to occupy cannot be measured.
 * These are honest estimates used for telemetry only - nothing is gated on them.
 */
const EXPECTED_MS = 45_000;

const AUDIT_STAGES = [
  {
    at: 0,
    title: "Uploading model",
    detail: "Sending the file to the audit service.",
  },
  {
    at: 6,
    title: "Importing geometry",
    detail:
      "OpenCASCADE is reading the solids and converting them to GLB for the viewer.",
  },
  {
    at: 32,
    title: "Measuring components",
    detail:
      "Extracting bounding-box dimensions, volumes and bore diameters from every solid.",
  },
  {
    at: 45,
    title: "Geometric interference pre-check",
    detail:
      "Testing component pairs for bounding-box overlap and minimum clearance.",
  },
  {
    at: 58,
    title: "Evaluating against specification",
    detail:
      "The audit model is comparing every measured dimension against your requirements.",
  },
  {
    at: 88,
    title: "Compiling findings",
    detail:
      "Building the inspection checklist, fix instructions and overall verdict.",
  },
];

/** Extensions the backend can parse. `.ifc` routes to the BIM processor. */
const ACCEPTED_EXTENSIONS = [".step", ".stp", ".ifc"];
/** Drives the file picker's filter; kept in sync with ACCEPTED_EXTENSIONS. */
const ACCEPT_ATTR = ".ifc,.step,.stp";

/**
 * The two intake slots, in the order they are shown.
 *
 * The labels name the disciplines the way an engineer would route the files,
 * but nothing downstream depends on them: the backend keys the two uploads as
 * `disciplineA` and `disciplineB` whatever they actually contain, because a
 * piping model and a structural one are geometrically identical to the audit.
 */
const DISCIPLINE_SLOTS: { key: DisciplineKey; label: string; hint: string }[] =
  [
    {
      key: "disciplineA",
      label: "Discipline 1: Piping / Mechanical (.ifc / .step)",
      hint: "Drag and drop here, or click to browse (.ifc, .step, .stp)",
    },
    {
      key: "disciplineB",
      label: "Discipline 2: Electrical / Structural (.ifc / .step)",
      hint: "Optional — drag and drop the second discipline here",
    },
  ];

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " " + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/** Small colour-coded status chip, shared by the header and the status banner. */
/**
 * The audit's overall verdict, as the header's status pill.
 *
 * Takes the failing check count so the pill can state what the verdict rests
 * on - "FAIL - 3 findings" rather than a bare "FAIL". A reviewer arriving at
 * the results should not have to open the panel to learn how much is wrong,
 * and the count is the one number that tells them.
 */
function StatusPill({
  status,
  failing = 0,
  className = "",
}: {
  status: CheckStatus;
  failing?: number;
  className?: string;
}) {
  const passed = status === "PASS";

  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wide ring-1 " +
        (passed
          ? "bg-emerald-50 text-emerald-700 ring-emerald-600/30 "
          : "bg-rose-50 text-rose-700 ring-rose-700/30 ") +
        className
      }
    >
      {passed ? (
        <CheckCircle2 className="h-3.5 w-3.5" />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5" />
      )}
      {passed ? "PASS" : `FAIL · ${failing} finding${failing === 1 ? "" : "s"}`}
    </span>
  );
}

/**
 * App icon badge. Shared by both phases so the brand reads identically whether
 * the user is configuring an audit or reading one.
 */
function BrandMark({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <div
      className={
        "flex shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm " +
        (size === "lg" ? "h-11 w-11" : "h-7 w-7")
      }
    >
      <ScanSearch className={size === "lg" ? "h-6 w-6" : "h-4 w-4"} />
    </div>
  );
}

/** The `v0.1.0 Beta` tag, kept in step with package.json rather than the brief. */
function VersionTag() {
  return (
    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-slate-500 ring-1 ring-slate-200">
      v0.1.0 Beta
    </span>
  );
}

/**
 * Axonometric CAD wireframe mark for the model dropzone.
 *
 * Drawn inline rather than taken from the icon set: no icon in lucide conveys
 * "isometric CAD solid", and a generic upload arrow undersells what the control
 * wants - a STEP or IFC model, not a document. Hidden edges are dashed, the way
 * a CAD wireframe actually renders.
 */
function CadWireframeIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden
      className={className}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    >
      {/* Outer isometric box: top face, then the two visible side faces. */}
      <path d="M32 6 58 20 32 34 6 20Z" />
      <path d="M6 20v24l26 14V34" />
      <path d="M58 20v24L32 58" />
      {/* Interior edges, dashed - the hidden geometry a wireframe exposes. */}
      <path d="M32 6v28" strokeDasharray="3 3" opacity="0.6" />
      <path d="M32 34 6 20" strokeDasharray="3 3" opacity="0.6" />
      <path d="M32 34l26-14" strokeDasharray="3 3" opacity="0.6" />
      {/* A measured feature: a bore through the top face. */}
      <circle cx="32" cy="20" r="6" strokeDasharray="4 3" opacity="0.75" />
    </svg>
  );
}

/** Green/red banner summarising the whole audit. */
function StatusBanner({ audit }: { audit: AuditResponse["audit"] }) {
  const passed = audit.overall_status === "PASS";

  return (
    <div
      className={
        "rounded-xl p-4 ring-1 " +
        (passed
          ? "bg-emerald-50 ring-emerald-600/20"
          : "bg-rose-50 ring-rose-700/20")
      }
    >
      <div className="flex items-start gap-3">
        {passed ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
        ) : (
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-700" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span
              className={
                "text-sm font-bold tracking-wide " +
                (passed ? "text-emerald-700" : "text-rose-700")
              }
            >
              {passed ? "PASSED" : "FAILED"}
            </span>
            <span className="text-xs text-slate-500">
              {audit.checks.length} check{audit.checks.length === 1 ? "" : "s"}
              {audit.failed_parts.length > 0 && (
                <>
                  {" · "}
                  <span className="text-rose-700">
                    {audit.failed_parts.length} non-compliant component
                    {audit.failed_parts.length === 1 ? "" : "s"}
                  </span>
                </>
              )}
            </span>
          </div>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-700">
            {audit.summary}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Full-screen intake view. Centred both ways, with a scroll container rather
 * than `items-center` alone so a short viewport scrolls the card instead of
 * clipping its top out of reach.
 */
/** Which half of card 2 is showing: an uploaded standard, or typed rules. */
type RequirementTab = "standard" | "text";

/** Extensions accepted as an uploaded standard/specification document. */
const STANDARD_ATTR = ".pdf,.txt,.md,.csv";

/**
 * One uploaded file, rendered as a single compact row.
 *
 * The intake used to show the file name AND size AND the dropzone's own prose at
 * once, which read as two overlapping records of one upload. The card replaces
 * the dropzone body outright, so there is exactly one line describing the file.
 */
function FileRow({
  file,
  onRemove,
  compact = false,
}: {
  file: File;
  onRemove?: () => void;
  /** Tighter row for the per-discipline dropzones, which sit two to a card. */
  compact?: boolean;
}) {
  const extension =
    fileExtension(file.name).replace(".", "").toUpperCase() || "FILE";

  return (
    <div
      className={
        "flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 " +
        (compact ? "p-2" : "p-3")
      }
    >
      <span className="shrink-0 rounded-md bg-blue-600 px-2 py-1 font-mono text-[10px] font-bold tracking-wide text-white">
        .{extension}
      </span>

      <div className="min-w-0 flex-1">
        <p
          className={
            "truncate font-medium text-slate-900 " +
            (compact ? "text-xs" : "text-sm")
          }
        >
          {file.name}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          {formatBytes(file.size)}
        </p>
      </div>

      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />

      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${file.name}`}
          title="Remove file"
          onClick={(event) => {
            // The row sits inside the dropzone, which opens the file picker on
            // click. Without this the remove button would also reopen it.
            event.stopPropagation();
            onRemove();
          }}
          className="shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-slate-200 hover:text-slate-700"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/**
 * Phase 1 intake: the two-step setup screen.
 *
 * Laid out as a two-column stepper rather than one stacked form, so the model
 * and the rules it will be judged against are visible together - the pairing is
 * the thing the user is actually configuring, and hiding one below the fold made
 * it easy to run an audit against the wrong specification.
 *
 * Card 1 carries a dropzone per discipline. A federated audit needs the two
 * files to arrive together - they are one assembly, and the inter-model clash
 * check has nothing to compare until both are present - so the second slot is
 * not a separate step the user advances to.
 */
function IntakeView({
  presetId,
  pendingPreset,
  presetError,
  file,
  secondaryFile,
  activeSlot,
  requirements,
  error,
  draggingSlot,
  tab,
  standardName,
  standardError,
  loading,
  inputRef,
  secondaryInputRef,
  standardInputRef,
  onAcceptFile,
  onRemoveFile,
  onDragStateChange,
  onFocusSlot,
  onRequirementsChange,
  onTabChange,
  onAcceptStandard,
  onClearStandard,
  onChoosePreset,
  onSubmit,
}: {
  presetId: string | null;
  pendingPreset: string | null;
  presetError: string | null;
  file: File | null;
  secondaryFile: File | null;
  /** Which slot a click or drag targets. The first empty slot by default. */
  activeSlot: DisciplineKey;
  requirements: string;
  error: string | null;
  /** The slot currently under a drag, so only that panel highlights. */
  draggingSlot: DisciplineKey | null;
  tab: RequirementTab;
  standardName: string | null;
  standardError: string | null;
  /** True while an audit is in flight, so the submit button can show a spinner. */
  loading: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  secondaryInputRef: React.RefObject<HTMLInputElement | null>;
  standardInputRef: React.RefObject<HTMLInputElement | null>;
  onAcceptFile: (
    slot: DisciplineKey,
    candidate: File | null | undefined
  ) => void;
  onRemoveFile: (slot: DisciplineKey) => void;
  onDragStateChange: (slot: DisciplineKey, dragging: boolean) => void;
  onFocusSlot: (slot: DisciplineKey) => void;
  onRequirementsChange: (value: string) => void;
  onTabChange: (tab: RequirementTab) => void;
  onAcceptStandard: (candidate: File | null | undefined) => void;
  onClearStandard: () => void;
  onChoosePreset: (preset: Preset) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const slotValue: Record<DisciplineKey, File | null> = {
    disciplineA: file,
    disciplineB: secondaryFile,
  };
  const slotRef: Record<
    DisciplineKey,
    React.RefObject<HTMLInputElement | null>
  > = {
    disciplineA: inputRef,
    disciplineB: secondaryInputRef,
  };

  /** The slot a click or a drop with no clear target should land in. */
  const targetSlot: DisciplineKey =
    activeSlot === "disciplineB" || (activeSlot === "disciplineA" && file)
      ? "disciplineB"
      : "disciplineA";

  const handleDrop = (slot: DisciplineKey, event: React.DragEvent) => {
    event.preventDefault();
    onDragStateChange(slot, false);
    // A federated pair arrives in one gesture whenever the browser supplies both
    // files, so the second dropzone does not have to be a second action.
    const dropped = Array.from(event.dataTransfer.files ?? []);
    if (dropped.length > 1) {
      dropped.slice(0, 2).forEach((candidate, index) => {
        onAcceptFile(index === 0 ? "disciplineA" : "disciplineB", candidate);
      });
      return;
    }
    onAcceptFile(slot, dropped[0]);
  };

  return (
    <div className="thin-scroll flex min-h-screen flex-col overflow-y-auto bg-slate-50">
      {/* ------------------------------- Header ------------------------------- */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:px-6">
        <BrandMark />
        <h1 className="truncate text-sm font-semibold tracking-tight text-slate-900">
          CAD Compliance Auditor
        </h1>
        <VersionTag />

        <div className="ml-auto flex items-center gap-2">
          {/* Present but inert during setup: the button belongs to the workbench,
              and showing it disabled keeps the header layout stable across the
              phase transition rather than shifting it on entry. */}
          <button
            type="button"
            disabled
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-400"
          >
            <Plus className="h-3.5 w-3.5" />
            New Audit
          </button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        <div className="mb-7 text-center">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">
            New Audit Project Setup
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Step 1 of 2: Configure CAD/BIM Assets &amp; Design Rules
          </p>
        </div>

        <form onSubmit={onSubmit}>
          <div className="grid gap-5 lg:grid-cols-2">
            {/* --------------------------- Card 1: model --------------------------- */}
            <section className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h3 className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                <span className="flex h-5 w-5 items-center justify-center rounded bg-slate-900 text-[10px] text-white">
                  1
                </span>
                Upload Model Files
              </h3>
              <p className="mb-4 text-[11px] leading-relaxed text-slate-500">
                Upload one model, or both disciplines of a federated assembly.
                Both are overlaid at a shared origin and audited together, so
                inter-discipline clashes are detectable.
              </p>

              <div className="flex flex-1 flex-col gap-3">
                {DISCIPLINE_SLOTS.map(({ key, label, hint }) => {
                  const value = slotValue[key];
                  const dragging = draggingSlot === key;
                  const input = slotRef[key];

                  return (
                    <div
                      key={key}
                      onDragOver={(e) => {
                        e.preventDefault();
                        onFocusSlot(key);
                        onDragStateChange(key, true);
                      }}
                      onDragLeave={() => onDragStateChange(key, false)}
                      onDrop={(e) => handleDrop(key, e)}
                      onClick={() => {
                        onFocusSlot(key);
                        input.current?.click();
                      }}
                      className={
                        "flex flex-1 cursor-pointer flex-col justify-center rounded-lg border-2 border-dashed px-3 py-4 text-center transition " +
                        (dragging
                          ? "border-blue-600 bg-blue-50"
                          : value
                          ? "border-slate-200 bg-slate-50/60 hover:border-slate-400"
                          : "border-slate-300 hover:border-slate-400 hover:bg-slate-50")
                      }
                    >
                      <p className="text-[11px] font-semibold text-slate-700">
                        {label}
                      </p>

                      {value ? (
                        <div className="mt-2 w-full text-left">
                          <FileRow
                            file={value}
                            compact
                            onRemove={() => onRemoveFile(key)}
                          />
                        </div>
                      ) : (
                        <p className="mt-1 text-[10px] text-slate-400">
                          {hint}
                        </p>
                      )}

                      <input
                        ref={input}
                        type="file"
                        accept={ACCEPT_ATTR}
                        className="hidden"
                        onChange={(e) => onAcceptFile(key, e.target.files?.[0])}
                      />
                    </div>
                  );
                })}

                {/* The slot a click with no explicit target lands in. Named
                    rather than implied, because with both empty "the first
                    dropzone" is a guess and the user is about to pick a file. */}
                <p className="text-center text-[11px] text-slate-400">
                  {targetSlot === "disciplineB"
                    ? "Slot 2 is optional — add it to audit both disciplines together."
                    : "Pick a file with either slot; the other stays optional."}
                </p>
              </div>
            </section>

            {/* ----------------------- Card 2: requirements ----------------------- */}
            <section className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h3 className="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                <span className="flex h-5 w-5 items-center justify-center rounded bg-slate-900 text-[10px] text-white">
                  2
                </span>
                Compliance Requirements
              </h3>

              <div
                role="tablist"
                aria-label="Requirement input method"
                className="mb-4 flex gap-1 rounded-lg bg-slate-100 p-1"
              >
                {(
                  [
                    { key: "standard", label: "Upload Standards (.pdf, .txt)" },
                    { key: "text", label: "Design Specifications (Text)" },
                  ] as const
                ).map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={tab === key}
                    onClick={() => onTabChange(key)}
                    className={
                      "flex-1 rounded-md px-2.5 py-2 text-[11px] font-semibold transition " +
                      (tab === key
                        ? "bg-white text-slate-900 shadow-sm"
                        : "text-slate-500 hover:text-slate-700")
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex min-h-0 flex-1 flex-col">
                {tab === "standard" ? (
                  <div className="flex flex-1 flex-col">
                    <div
                      onClick={() => standardInputRef.current?.click()}
                      className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 px-4 py-8 text-center transition hover:border-slate-400 hover:bg-slate-50"
                    >
                      <Upload className="h-6 w-6 text-slate-400" />
                      <p className="mt-2.5 text-sm font-medium text-slate-700">
                        Drop a standard or client specification
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        ASME, ISO or project specs (.pdf, .txt)
                      </p>
                      <input
                        ref={standardInputRef}
                        type="file"
                        accept={STANDARD_ATTR}
                        className="hidden"
                        onChange={(e) => onAcceptStandard(e.target.files?.[0])}
                      />
                    </div>

                    {standardName && (
                      <div className="mt-2 flex items-center gap-2 rounded-lg border border-emerald-600/20 bg-emerald-50 px-3 py-2">
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-emerald-800">
                          {standardName} loaded
                        </span>
                        <button
                          type="button"
                          aria-label="Clear the loaded standard"
                          onClick={onClearStandard}
                          className="shrink-0 rounded p-0.5 text-emerald-700/60 transition hover:text-emerald-900"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}

                    {standardError && (
                      <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
                        {standardError}
                      </p>
                    )}

                    <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                      Rules are read into the field below, where you can review
                      and edit them before running the audit.
                    </p>
                  </div>
                ) : (
                  <textarea
                    value={requirements}
                    onChange={(e) => onRequirementsChange(e.target.value)}
                    rows={8}
                    placeholder={
                      "e.g. The base plate must be 120 mm long, 40 mm wide and 10 mm thick.\n" +
                      "The mounting post must be 25 x 25 x 60 mm.\n" +
                      "Tolerance: +/- 0.5 mm."
                    }
                    className="thin-scroll w-full flex-1 resize-y rounded-lg border border-slate-300 bg-white p-3 font-mono text-xs leading-relaxed text-slate-800 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600"
                  />
                )}
              </div>

              <div className="mt-4 border-t border-slate-100 pt-3">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Quick load
                </p>
                <div className="flex flex-wrap gap-2">
                  {PRESETS.map((preset) => {
                    const active = presetId === preset.id;
                    const busy = pendingPreset === preset.id;

                    return (
                      <button
                        key={preset.id}
                        type="button"
                        disabled={pendingPreset !== null}
                        onClick={() => onChoosePreset(preset)}
                        className={
                          "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition disabled:cursor-wait " +
                          (active
                            ? "border-blue-600 bg-blue-50 text-blue-800"
                            : "border-slate-300 text-slate-600 hover:bg-slate-50 hover:text-slate-900")
                        }
                      >
                        {busy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <FileBox className="h-3.5 w-3.5" />
                        )}
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                  Loads the specification and its matching model, ready to
                  audit.
                </p>
              </div>
            </section>
          </div>

          {(error || presetError) && (
            <div className="mt-5 flex items-start gap-2.5 rounded-lg border border-rose-700/25 bg-rose-50 p-3">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-700" />
              <p className="text-xs leading-relaxed text-rose-800">
                {error ?? presetError}
              </p>
            </div>
          )}

          {/* ---------------------------- Execution bar ---------------------------- */}
          <div className="mt-6 flex justify-center">
            <button
              type="submit"
              disabled={!file || loading}
              className="flex w-full max-w-md items-center justify-center gap-2 rounded-lg bg-blue-800 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ScanSearch className="h-4 w-4" />
              )}
              Validate and Run Audit
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Shown for the whole duration of the request. The audit is one opaque POST, so
 * the stage shown is derived from elapsed time and labelled as an estimate
 * rather than presented as server-reported progress it cannot actually observe.
 */
function LoadingTelemetry({
  fileName,
  elapsedMs,
  onCancel,
}: {
  fileName: string | null;
  elapsedMs: number;
  onCancel: () => void;
}) {
  const progress = Math.min(97, (elapsedMs / EXPECTED_MS) * 100);
  const stage =
    [...AUDIT_STAGES].reverse().find((entry) => progress >= entry.at) ??
    AUDIT_STAGES[0];
  const seconds = Math.floor(elapsedMs / 1000);
  const slow = elapsedMs >= WARMUP_MS;

  return (
    <div className="flex min-h-screen flex-col overflow-y-auto bg-slate-50 px-4 py-8 sm:px-6">
      <div className="m-auto w-full max-w-xl py-12 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-sm">
          <Loader2 className="h-7 w-7 animate-spin" />
        </div>

        <h1 className="mt-5 text-lg font-semibold tracking-tight text-slate-900">
          Auditing geometry
        </h1>
        {fileName && (
          <p className="mt-1 break-all font-mono text-xs text-slate-500">
            {fileName}
          </p>
        )}

        <div className="mt-7 rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-slate-900">{stage.title}</p>
            <span className="shrink-0 font-mono text-xs text-slate-500">
              {progress.toFixed(0)}% · {seconds}s
            </span>
          </div>

          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-blue-600 transition-[width] duration-700 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>

          <p className="mt-3 text-xs leading-relaxed text-slate-600">
            {stage.detail}
          </p>

          <ol className="mt-4 space-y-1.5 border-t border-slate-100 pt-3">
            {AUDIT_STAGES.map((entry) => {
              const done = entry.at < stage.at;
              const current = entry.at === stage.at;

              return (
                <li
                  key={entry.at}
                  className={
                    "flex items-center gap-2 text-[11px] " +
                    (current
                      ? "text-blue-700 font-medium"
                      : done
                      ? "text-slate-500"
                      : "text-slate-400")
                  }
                >
                  <span className="w-3.5 shrink-0 text-center font-mono">
                    {done ? "✓" : current ? "▸" : "·"}
                  </span>
                  {entry.title}
                </li>
              );
            })}
          </ol>

          <p className="mt-4 border-t border-slate-100 pt-3 text-[11px] leading-relaxed text-slate-500">
            <span className="text-slate-600">Estimated stage</span> &mdash; the
            audit service returns one response, so this is a projection from
            elapsed time, not reported progress.
          </p>
        </div>

        {slow && (
          <p className="mt-4 text-xs leading-relaxed text-amber-700">
            Still working &mdash; large STEP assemblies can take a minute or
            more. If this does not finish, check that the backend is running on
            port 8000.
          </p>
        )}

        <button
          type="button"
          onClick={onCancel}
          className="mt-6 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 transition hover:bg-white hover:text-slate-900"
        >
          <X className="h-3.5 w-3.5" />
          Cancel audit
        </button>
      </div>
    </div>
  );
}

/** Header export control: one button, two formats behind it. */
function ExportMenu({
  onExportJson,
  onPrint,
  disabled,
}: {
  onExportJson: () => void;
  onPrint: () => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(
    null
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /**
   * The workbench root is `overflow-hidden` (nothing outside the window should
   * scroll), and the 48px header is too short to contain this menu either above
   * or below itself - an in-flow menu is clipped to zero clickable height. So it
   * is portalled to the body, the one element that does scroll, and positioned
   * from the button's own rect.
   */
  const place = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setCoords({
      top: rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, []);

  const toggle = useCallback(() => {
    setOpen((value) => {
      // Position on open rather than in an effect, so the menu never paints
      // once at the old coordinates before jumping.
      if (!value) place();
      return !value;
    });
  }, [place]);

  // Dismiss on an outside click or Escape, and follow the button while the
  // window is resized or scrolled. Pointerdown rather than click: the header
  // sits above the 3D canvas, which swallows clicks that start on it.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        menuRef.current?.contains(target) ||
        buttonRef.current?.contains(target)
      )
        return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className="flex items-center gap-1.5 rounded-lg bg-blue-800 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
      >
        <Download className="h-3.5 w-3.5" />
        Export Report
        <ChevronDown
          className={
            "h-3 w-3 transition-transform " + (open ? "rotate-180" : "")
          }
        />
      </button>

      {open &&
        coords &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ top: coords.top, right: coords.right }}
            className="animate-fade-in fixed z-50 w-48 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-xl shadow-slate-900/10"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onExportJson();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-slate-700 transition hover:bg-slate-50 hover:text-slate-900"
            >
              <Download className="h-3.5 w-3.5 shrink-0" />
              Download JSON Record
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPrint();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-slate-700 transition hover:bg-slate-50 hover:text-slate-900"
            >
              <Printer className="h-3.5 w-3.5 shrink-0" />
              Print / Save PDF
            </button>
          </div>,
          document.body
        )}
    </>
  );
}

export default function HomePage() {
  /** Discipline 1 (piping / mechanical). Always the model the audit opens on. */
  const [file, setFile] = useState<File | null>(null);
  /** Discipline 2 (electrical / structural). Optional; its presence federates. */
  const [secondaryFile, setSecondaryFile] = useState<File | null>(null);
  /**
   * The slot a click or a drag targets.
   *
   * Only file A is required, so a click on the card as a whole - outside either
   * dropzone - has to resolve to a definite slot rather than silently doing
   * nothing. This records the last slot the user engaged with, and defaults to
   * the first one that is still empty.
   */
  const [activeSlot, setActiveSlot] = useState<DisciplineKey>("disciplineA");
  const [requirements, setRequirements] = useState("");
  const [loading, setLoading] = useState(false);
  /** Real elapsed time for the loading telemetry; there is no server progress to read. */
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AuditResponse | null>(null);
  /** The slot currently under a drag, so only that dropzone highlights. */
  const [draggingSlot, setDraggingSlot] = useState<DisciplineKey | null>(null);
  /** Which preset produced the current form contents; cleared by any manual edit. */
  const [presetId, setPresetId] = useState<string | null>(null);
  /** Preset currently being fetched from /samples, so it can show a spinner. */
  const [pendingPreset, setPendingPreset] = useState<string | null>(null);
  /** A preset fetch that failed - kept apart from `error`, which owns audit failures. */
  const [presetError, setPresetError] = useState<string | null>(null);
  /** part_id picked in the 3D viewer; drives the badge and the checklist highlight. */
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  /**
   * Whether the current selection should bring its checklist row into view.
   *
   * True only when the click came from the checklist itself. A click on the
   * model must not scroll the panel - the user is looking at the 3D view, and
   * moving the viewport under them fights the camera animation.
   */
  const [scrollToRow, setScrollToRow] = useState(false);
  /** Engineer sign-off, keyed by decisionKey(check, index). Persisted. */
  const [decisions, setDecisions] = useState<DecisionMap>({});
  /** Reviewer comment threads, keyed by the same identity as decisions. Persisted. */
  const [comments, setComments] = useState<CommentMap>({});
  /** The name and role stamped on comments this reviewer posts. Persisted. */
  const [reviewer, setReviewer] = useState<Reviewer>(DEFAULT_REVIEWER);
  /** Whether the reviewer-identity dialog is showing. */
  const [reviewerOpen, setReviewerOpen] = useState(false);
  /**
   * Index of the finding a 3D pin pointed at, or null.
   *
   * Separate from `selectedPartId`: one part can carry several findings, so the
   * part alone does not say which card the pin meant. The feed scrolls to this
   * index rather than to the first card for the part.
   */
  const [selectedCheckIndex, setSelectedCheckIndex] = useState<number | null>(
    null
  );
  /** part_ids hidden in the model tree. */
  const [hiddenParts, setHiddenParts] = useState<string[]>([]);
  /** When set, every other component is hidden. */
  const [isolatedPartId, setIsolatedPartId] = useState<string | null>(null);
  /**
   * A linked viewpoint to fly the camera to, from a comment's "Look at this
   * view".
   *
   * Held here rather than in the viewer because the request comes from the
   * discussion feed, and the viewer is mounted with `ssr: false` behind a
   * dynamic import - the panel can post a request before the canvas exists. The
   * nonce is incremented per click so that re-requesting the same message is a
   * new instruction rather than an identical object the viewer would ignore.
   */
  const [cameraRequest, setCameraRequest] = useState<CameraFocusRequest | null>(
    null
  );
  /** Monotonic source of `cameraRequest` nonces. */
  const cameraNonceRef = useRef(0);


  /**
   * Every name that has posted in the discussion, oldest first.
   *
   * A fold over every thread rather than over the visible finding's thread: the
   * discussion dock asks "has anyone else joined", which is a question about
   * the session, and answering it from one card's comments would report nobody
   * to a reviewer who happens to have opened a finding only they have
   * commented on. Derived rather than stored, so a comment arriving from the
   * other browser tab updates it with no extra bookkeeping.
   */
  const participants = useMemo(() => {
    const seen: string[] = [];
    for (const thread of Object.values(comments)) {
      for (const comment of thread) {
        if (!seen.includes(comment.author)) seen.push(comment.author);
      }
    }
    return seen;
  }, [comments]);
  /** Set once the reviewer confirms exporting a partially-reviewed audit. */
  const [exportWarning, setExportWarning] = useState<string | null>(null);
  /** Which tab of the docked inspector is open; null closes the panel. */
  const [activePanel, setActivePanel] = useState<"tree" | "findings" | null>(
    "findings"
  );
  /** Whether the team chat rail on the right is open. */
  const [chatOpen, setChatOpen] = useState(false);
  /** The team channel's unsent message, lifted so it survives a re-render. */
  const [chatDraft, setChatDraft] = useState("");
  /** Which half of card 2 the intake is showing: an uploaded standard, or typed rules. */
  const [requirementTab, setRequirementTab] = useState<RequirementTab>("text");
  /** Name of the standard document loaded into the requirements field, if any. */
  const [standardName, setStandardName] = useState<string | null>(null);
  /** Why an uploaded standard could not be read - kept apart from `error`. */
  const [standardError, setStandardError] = useState<string | null>(null);
  /**
   * When the audit response landed.
   *
   * The API carries no timestamp for a finding, so the card's author header has
   * nothing truthful to show - a hard-coded "2m ago" would claim a precision
   * that does not exist. Stamping the response arrival gives the header a real
   * reference point, and relative times read correctly from it.
   */
  const [receivedAt, setReceivedAt] = useState<string>("");

  const inputRef = useRef<HTMLInputElement>(null);
  /** Discipline 2's model picker, in card 1's second dropzone. */
  const secondaryInputRef = useRef<HTMLInputElement>(null);
  /** The standard/specification document picker in card 2's first tab. */
  const standardInputRef = useRef<HTMLInputElement>(null);
  /** Lets "Cancel audit" discard a response that arrives after the click. */
  const auditTokenRef = useRef(0);

  /**
   * False until the stored review has been read into state.
   *
   * This gate is load-bearing, not defensive. The restore effect and the two
   * persist effects are all flushed from the same mount commit, in declaration
   * order, so the persist effects run while `decisions` and `comments` still
   * hold their initial empty values - and both savers treat an empty map as
   * "clear the stored value" and call `removeItem`. Without this flag, every
   * page load deletes the saved review a moment before reading it, and the
   * second load has nothing left to restore.
   */
  const [reviewLoaded, setReviewLoaded] = useState(false);

  /**
   * The committed comment map, for the broadcast in the handlers that write it.
   *
   * The publishers need the thread as it will be AFTER the change, and the
   * updater form of `setComments` does not hand it back. The alternative -
   * deriving the next map inline from the captured `comments` - would publish a
   * stale map for any two edits made before React re-rendered, which is exactly
   * the case a second tab creates. Held in an effect rather than assigned inside
   * the updater, because an updater may run twice for one commit and must stay
   * pure.
   */
  const commentsRef = useRef<CommentMap>({});

  useEffect(() => {
    commentsRef.current = comments;
  }, [comments]);

  useEffect(() => {
    setDecisions(loadDecisions());
    setComments(loadComments());
    setReviewer(loadReviewer());
    setReviewLoaded(true);
  }, []);

  /**
   * Listen for review activity from the other tabs.
   *
   * Mounted for the whole life of the page rather than only once a response has
   * landed: a comment posted in this tab while another tab is still on the
   * intake screen has to be waiting for it when it gets there, and the receiving
   * side applies a thread wholesale, so it needs no findings of its own to hold
   * the state.
   *
   * The handler reads nothing from the closure beyond the setState functions,
   * which is why the dependency list is empty - patching is done inside the
   * updater, so the effect never has to re-subscribe and never briefly goes deaf
   * while it does.
   */
  useEffect(() => {
    const active = collaborationChannel();
    if (!active) return;

    const onMessage = (message: MessageEvent<unknown>) => {
      const event = readCollaborationMessage(message.data);
      if (!event) return;

      if (event.type === "comments") {
        const { threadKey, thread } = event;
        setComments((current) => {
          // A thread that empties out is deleted rather than left as an empty
          // array: an empty key would still count as a commented finding in the
          // stream's filter, and the sender's own delete removes the key.
          const next = { ...current };
          if (thread.length > 0) next[threadKey] = thread;
          else delete next[threadKey];
          return next;
        });
        return;
      }

      const { threadKey, decision } = event;
      setDecisions((current) => {
        const next = { ...current };
        if (decision) next[threadKey] = decision;
        else delete next[threadKey];
        return next;
      });
    };

    active.addEventListener("message", onMessage);
    return () => {
      active.removeEventListener("message", onMessage);
      // Closed rather than left open: the module-level handle would otherwise
      // point at a channel with no listener, and the next post on it would go
      // nowhere while still looking alive.
      if (channel === active) {
        active.close();
        channel = null;
      }
    };
  }, []);

  // Persist on change. Writing here rather than inside each handler means every
  // path that changes a decision is covered, including a clear.
  useEffect(() => {
    if (!reviewLoaded) return;
    saveDecisions(decisions);
  }, [decisions, reviewLoaded]);

  useEffect(() => {
    if (!reviewLoaded) return;
    saveComments(comments);
  }, [comments, reviewLoaded]);

  // Drive the loading telemetry. Reset in the same effect that starts it so a
  // second audit never shows the previous run's elapsed time.
  useEffect(() => {
    if (!loading) {
      setElapsedMs(0);
      return;
    }

    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setElapsedMs(Date.now() - startedAt),
      250
    );
    return () => window.clearInterval(timer);
  }, [loading]);

  const acceptFile = useCallback(
    (slot: DisciplineKey, candidate: File | null | undefined) => {
      if (!candidate) return;

      if (!ACCEPTED_EXTENSIONS.includes(fileExtension(candidate.name))) {
        setError("Unsupported file type. Upload a .step, .stp or .ifc file.");
        return;
      }
      setError(null);
      setPresetError(null);
      if (slot === "disciplineA") setFile(candidate);
      else setSecondaryFile(candidate);
      setActiveSlot(slot);
      // A hand-picked file no longer matches whichever preset filled the spec.
      setPresetId(null);
      setResult(null);
    },
    []
  );

  /**
   * Drop a chosen model file.
   *
   * The input's own value is cleared too: picking the same file twice in a row
   * fires no change event while the input still holds that path, so without this
   * re-selecting a file the user just removed would silently do nothing.
   */
  const removeFile = useCallback((slot: DisciplineKey) => {
    if (slot === "disciplineA") {
      setFile(null);
      setSecondaryFile(null);
      if (secondaryInputRef.current) secondaryInputRef.current.value = "";
    } else {
      // Removing discipline 2 leaves a plain single-model audit; it does not
      // promote the second file into the first slot, which would silently
      // change which file the audit is reported against.
      setSecondaryFile(null);
    }
    setActiveSlot(slot);
    setPresetId(null);
    setResult(null);
    setError(null);
    const input =
      slot === "disciplineA" ? inputRef.current : secondaryInputRef.current;
    if (input) input.value = "";
  }, []);

  /** A drag entering or leaving one dropzone. */
  const handleDragStateChange = useCallback(
    (slot: DisciplineKey, dragging: boolean) => {
      setDraggingSlot((current) =>
        dragging ? slot : current === slot ? null : current
      );
    },
    []
  );

  /**
   * Read an uploaded standard into the requirements field.
   *
   * Text is extracted in the browser and dropped straight into the textarea the
   * user would otherwise type into, rather than being kept as a second, parallel
   * source of rules. The audit takes one free-text `requirements` string, so a
   * standard that stayed a separate file would either be ignored or need its own
   * backend path; putting it in the field makes what will be audited visible and
   * editable, which is the point of the tab.
   *
   * PDF is the awkward case: it is a container format, and pulling text out of
   * it properly needs a parser this app does not ship. Rather than silently
   * mangle binary into the field, an unreadable PDF says so and asks for the
   * rules as text.
   */
  const acceptStandard = useCallback(
    async (candidate: File | null | undefined) => {
      if (!candidate) return;

      const extension = fileExtension(candidate.name);
      setStandardError(null);

      if (extension === ".pdf") {
        // A PDF may still carry a plain-text stream, so try before giving up - but
        // never paste bytes that are obviously not text into the field.
        const text = await candidate.text().catch(() => "");
        const readable = text.replace(/[^ -~\s]/g, "").trim();
        if (readable.length < 40) {
          setStandardName(null);
          setStandardError(
            `${candidate.name} is a PDF, which has to be read as text. Open it, copy the ` +
              "requirements, and paste them into the Design Specifications tab."
          );
          return;
        }
        setRequirements(readable);
        setPresetId(null);
        setStandardName(candidate.name);
        setRequirementTab("text");
        return;
      }

      const text = await candidate.text().catch(() => "");
      if (!text.trim()) {
        setStandardError(`Could not read any text from ${candidate.name}.`);
        return;
      }

      setRequirements(text);
      // The field no longer holds a preset's specification verbatim.
      setPresetId(null);
      setStandardName(candidate.name);
      setRequirementTab("text");
    },
    []
  );

  const clearStandard = useCallback(() => {
    setStandardName(null);
    setStandardError(null);
    if (standardInputRef.current) standardInputRef.current.value = "";
  }, []);

  /**
   * Load a preset's model and specification in one click. The file is fetched
   * rather than kept on disk as a File, because the audit POSTs a real File
   * whose bytes must be a genuine STEP or IFC stream.
   */
  const choosePreset = useCallback(async (preset: Preset) => {
    setPendingPreset(preset.id);
    setPresetError(null);
    setError(null);

    try {
      const response = await fetch(preset.url);
      if (!response.ok) throw new Error(String(response.status));

      const blob = await response.blob();
      // Built rather than taken from the Content-Disposition header: the name
      // is what the audit report cites as the source file.
      const next = new File([blob], preset.fileName, {
        type: "application/octet-stream",
      });

      setFile(next);
      // A preset is one model and one specification written against it. Leaving
      // a previously chosen discipline 2 in place would federate it with the
      // sample and audit the pairing against a spec that never described it.
      setSecondaryFile(null);
      setActiveSlot("disciplineA");
      setRequirements(preset.spec);
      setPresetId(preset.id);
      setResult(null);
      if (inputRef.current) inputRef.current.value = "";
      if (secondaryInputRef.current) secondaryInputRef.current.value = "";
    } catch {
      setPresetError(
        `Could not load the ${preset.label} sample. Check that ${preset.url} is being served.`
      );
    } finally {
      setPendingPreset(null);
    }
  }, []);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!file || loading) return;

      const token = ++auditTokenRef.current;

      setLoading(true);
      setError(null);
      setResult(null);
      setSelectedPartId(null);
      setSelectedCheckIndex(null);
      setScrollToRow(false);

      // Both disciplines travel in one multipart payload. The backend merges
      // them into a single part-id namespace and runs the clash pre-check
      // across the union, which is what lets it see an inter-discipline
      // interference at all - neither file's own solids can clash with the
      // other's if they are audited one at a time.
      const form = new FormData();
      form.append("step_file", file);
      if (secondaryFile) form.append("discipline_b_file", secondaryFile);
      form.append("requirements", requirements);

      try {
        const response = await fetch("/api/audit", {
          method: "POST",
          body: form,
        });

        if (!response.ok) {
          // FastAPI reports failures as {"detail": "..."}; fall back to the
          // status line if the body is not JSON (e.g. a proxy error page).
          const payload = await response.json().catch(() => null);
          throw new Error(
            payload?.detail ??
              "Audit failed with status " + response.status + "."
          );
        }

        const payload = (await response.json()) as AuditResponse;
        // A cancelled run must not resurrect itself when its response lands.
        if (token !== auditTokenRef.current) return;

        setResult(payload);
        setReceivedAt(new Date().toISOString());
        setHiddenParts([]);
        setIsolatedPartId(null);
        setExportWarning(null);
        // Decisions and comments are keyed by check identity, which only exists
        // relative to a response. Drop any that do not correspond to a check in
        // this one, so a previous model's sign-off or thread cannot leak onto a
        // new upload that happens to reuse ids like `part_1`.
        setDecisions(
          (current) =>
            reconcileDecisions(current, payload.audit.checks).decisions
        );
        setComments(
          (current) => reconcileComments(current, payload.audit.checks).comments
        );
      } catch (err) {
        if (token !== auditTokenRef.current) return;
        setError(
          err instanceof Error
            ? err.message
            : "Could not reach the audit service. Is the backend running on port 8000?"
        );
      } finally {
        if (token === auditTokenRef.current) setLoading(false);
      }
    },
    [file, secondaryFile, requirements, loading]
  );

  /** Drop an in-flight audit. The request itself cannot be aborted through the
   *  proxy, but bumping the token stops its response from being applied. */
  const cancelAudit = useCallback(() => {
    auditTokenRef.current += 1;
    setLoading(false);
  }, []);

  const failedParts = useMemo(() => result?.audit.failed_parts ?? [], [result]);

  /**
   * The findings, for the handlers that key off them.
   *
   * Read through `result` rather than held as its own state: the checks ARE the
   * response's, and a second copy would be one more thing to clear on reset and
   * to keep in step when a re-audit lands.
   */
  const checks = useMemo<CheckItem[]>(() => result?.audit.checks ?? [], [result]);

  /**
   * Each finding's thread key against the coordinate the viewer resolved for it.
   *
   * Reported up by the scene, because it is the only place that holds both
   * halves: the comment store is keyed by finding identity, and a coordinate
   * does not exist until the GLB has loaded and the placement is known. The page
   * turns this table plus the comment map into clouds - see `groupAnnotations`.
   */
  const [findingAnchors, setFindingAnchors] = useState<
    Map<string, [number, number, number]>
  >(new Map());

  const handleAnchorsResolved = useCallback(
    (next: Map<string, [number, number, number]>) => {
      setFindingAnchors((current) => {
        // Compared entry-wise: the scene recomputes this whenever the anchors,
        // the checks or the placement change, and a fresh map holding the same
        // coordinates would re-render every cloud for nothing.
        if (current.size === next.size) {
          let same = true;
          for (const [key, value] of next) {
            const held = current.get(key);
            if (
              !held ||
              held[0] !== value[0] ||
              held[1] !== value[1] ||
              held[2] !== value[2]
            ) {
              same = false;
              break;
            }
          }
          if (same) return current;
        }
        return next;
      });
    },
    []
  );

  /**
   * The comment clouds to draw.
   *
   * Derived rather than stored: a cloud is nothing but a comment plus a
   * coordinate, and both are already state. A third copy would be one more thing
   * to keep in step with the comment store, the cross-tab channel and the
   * re-audit reset - and the reset is exactly where a stale copy would survive
   * as a cloud over a model that is no longer loaded.
   */
  const annotationStacks = useMemo(
    () => groupAnnotations(commentAnnotations(comments, findingAnchors)),
    [comments, findingAnchors]
  );

  /**
   * How much of the viewport the docked panels cover, per side.
   *
   * Stated in pixels rather than measured from the DOM, because these are the
   * same numbers the panels are laid out at - `w-[460px]` for the inspector and
   * `w-[340px]` for the chat rail. Reading them back off the elements would be
   * a second source of truth for a value the JSX already fixes.
   *
   * A closed panel contributes nothing: it is translated off screen, so the
   * canvas under it is genuinely visible and a cloud may use it.
   */
  const panelInsets = useMemo(
    () => ({
      left: activePanel === null ? 0 : 460,
      right: chatOpen ? 340 : 0,
    }),
    [activePanel, chatOpen]
  );

  /** Every cloud's comment, flat, for the layer to look one up by id. */
  const annotationsById = useMemo(() => {
    const table = new Map<string, ViewerAnnotation>();
    annotationStacks.forEach((stack) => {
      stack.members.forEach((annotation) => table.set(annotation.id, annotation));
    });
    return table;
  }, [annotationStacks]);

  /**
   * The cloud the reviewer has open, or null.
   *
   * Lifted here rather than kept inside the viewer layer, so the cloud and the
   * inspector always name the same comment. Several clouds can share a
   * coordinate, so deriving "which is open" from the selected *finding* - the
   * way the marker bubble does - would light up every cloud at that point.
   */
  const [openAnnotationId, setOpenAnnotationId] = useState<string | null>(null);

  /**
   * Open a cloud: read its comment, and fly the camera to its coordinate.
   *
   * Both halves matter. The words alone leave the reviewer hunting for the
   * defect, which on a five-metre pipe run is most of the work; the flight alone
   * leaves them looking at a point with nothing said about it.
   *
   * The camera flies through the *finding* path rather than a viewpoint, because
   * a comment records a point and not a pose. The viewer bumps its own focus
   * nonce as part of reporting the click, so the re-framing is already
   * requested by the time this runs; what is left for the page is to make the
   * finding the *selected* one, which is what the camera flies to. The
   * comment's own thread key is used to find it, so a comment on a clash is not
   * sent to a neighbouring finding that shares a part.
   */
  const handleOpenAnnotation = useCallback(
    (annotation: ViewerAnnotation) => {
      setOpenAnnotationId((current) =>
        current === annotation.id ? null : annotation.id
      );

      const index = checks.findIndex(
        (check, position) => decisionKey(check, position) === annotation.threadKey
      );
      if (index < 0) return;

      setSelectedPartId(checks[index].part_id);
      setSelectedCheckIndex(index);
      setActivePanel("findings");
      setScrollToRow(true);
    },
    [checks]
  );

  const handleCloseAnnotation = useCallback(() => setOpenAnnotationId(null), []);

  /** A click in the 3D viewer: select the part, but never scroll the panel. */
  const handleViewerSelect = useCallback((partId: string | null) => {
    setScrollToRow(false);
    setSelectedPartId(partId);
    // A plain canvas click is not a request to open a card, so the pin's target
    // index no longer means anything.
    setSelectedCheckIndex(null);
  }, []);

  /** A click on a checklist row: select the part and bring the row into view. */
  const handleRowSelect = useCallback((partId: string) => {
    setScrollToRow(true);
    setSelectedCheckIndex(null);
    // Clicking the selected row again clears it, matching the viewer's toggle.
    setSelectedPartId((current) => (current === partId ? null : partId));
  }, []);

  /**
   * A click on a 3D annotation pin.
   *
   * Unlike a canvas click, this is an explicit request to read the finding, so
   * it does the two things a canvas click deliberately does not: it opens the
   * inspector (the pin may be clicked while the model tree tab is showing) and
   * it asks the feed to scroll the matching card into view.
   */
  const handlePinOpenFinding = useCallback(
    (partId: string, checkIndex: number) => {
      setSelectedPartId(partId);
      setSelectedCheckIndex(checkIndex);
      setActivePanel("findings");
      setScrollToRow(true);
    },
    []
  );

  /**
   * Dismiss the finding the viewport is narrating.
   *
   * Deliberately does not touch `selectedPartId`: the marker's bubble and the
   * inspector are two readings of the same finding, and putting the bubble away
   * is a request to stop annotating the canvas, not to close the drawer the
   * reviewer may still be reading. `handleViewerSelect` is the one that clears
   * both, because a canvas click that hits no part is a request to deselect.
   */
  const handleCloseFinding = useCallback(() => {
    setSelectedCheckIndex(null);
    setScrollToRow(false);
  }, []);

  /**
   * Return to the intake view. Every piece of audit state goes, including the
   * sign-off: decisions are keyed by check identity, which only means anything
   * relative to the response they came from.
   */
  const reset = useCallback(() => {
    auditTokenRef.current += 1;
    setFile(null);
    setSecondaryFile(null);
    setActiveSlot("disciplineA");
    setDraggingSlot(null);
    setResult(null);
    setError(null);
    setPresetError(null);
    setPresetId(null);
    setRequirements("");
    setRequirementTab("text");
    setStandardName(null);
    setStandardError(null);
    setReceivedAt("");
    setSelectedPartId(null);
    setSelectedCheckIndex(null);
    setScrollToRow(false);
    setHiddenParts([]);
    setIsolatedPartId(null);
    setExportWarning(null);
    setDecisions({});
    setComments({});
    // A linked viewpoint names a pose in the model that is about to be
    // unmounted. Left set, it would fly the next audit's camera to a coordinate
    // from the previous file.
    setCameraRequest(null);
    // Same reasoning for the clouds: an open cloud names a comment on a finding
    // that is about to stop existing, and the anchor table describes meshes that
    // are about to be replaced. The comments themselves go with `setComments`
    // above, so leaving either behind would point at nothing.
    setOpenAnnotationId(null);
    setFindingAnchors(new Map());
    setReviewerOpen(false);
    clearDecisions();
    clearComments();
    if (inputRef.current) inputRef.current.value = "";
    if (secondaryInputRef.current) secondaryInputRef.current.value = "";
  }, []);

  /**
   * Record or update one finding's sign-off.
   *
   * `notes` is carried through rather than asked for at the call site: the
   * review card's one-click toggles have no note field of their own, and the
   * reviewer's reasoning now lives in the comment thread, where it is a
   * first-class part of the record rather than a footnote on a verdict.
   */
  const handleDecide = useCallback(
    (check: CheckItem, index: number, verdict: DecisionVerdict, notes = "") => {
      const key = decisionKey(check, index);
      const decision: Decision = {
        verdict,
        notes,
        decidedAt: new Date().toISOString(),
      };
      setDecisions((current) => ({ ...current, [key]: decision }));
      setExportWarning(null);
      // The sign-off is paged out to the other tabs; a review being walked by
      // two people at once is the point of the shared channel.
      broadcast({ type: "decision", threadKey: key, decision });
    },
    []
  );

  const handleClearDecision = useCallback((check: CheckItem, index: number) => {
    const key = decisionKey(check, index);
    setDecisions((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    // Published as an explicit null rather than as an absent field: "this finding
    // is unsigned" is a real change the other tab has to apply, and it is not
    // expressible by simply omitting the key.
    broadcast({ type: "decision", threadKey: key, decision: null });
  }, []);

  /**
   * Append a comment to one finding's thread, stamped with the reviewer.
   *
   * The live camera pose is captured here, at the instant of posting, and rides
   * along as a linked viewpoint. It is read from the viewer's published surface
   * rather than passed in as an argument because the pose is not state anywhere
   * in the app - it changes every frame, and lifting it into React would
   * re-render the whole workbench at 60 fps to feed a value that is only ever
   * read once. `captureViewpoint` returns null when the viewer is not mounted,
   * and the comment is then posted without one.
   */
  /**
   * Write one comment into a thread, whatever raised it.
   *
   * The single write path, shared by the finding card's composer and the
   * composer on a 3D comment cloud. It takes a thread key rather than a check
   * because the cloud layer holds only the opaque key it was handed - it knows
   * nothing about findings, which is the same separation that keeps it free of
   * `CheckItem` - and because both callers must produce byte-identical comments.
   * A second write path would be a second place for the anchor capture, the
   * broadcast shape or the de-duplication to drift.
   */
  const postCommentTo = useCallback(
    (key: string, body: string) => {
      const comment: ReviewComment = {
        id: makeId(),
        author: reviewer.name,
        role: reviewer.role,
        body,
        createdAt: new Date().toISOString(),
        viewpoint: captureViewpoint() ?? undefined,
        // The coordinate the reviewer was looking at, so this comment can be
        // drawn as a cloud over the model and clicked to fly back here. Read at
        // the same instant as the pose and for the same reason: both describe
        // where the reviewer was, and both are gone the moment they orbit away.
        //
        // Absent when nothing was anchored, or when the comment was written from
        // the feed's own composer with no finding open - a cloud has to have a
        // place on the model to point at.
        anchor: captureAnchor() ?? undefined,
      };
      setComments((current) => ({
        ...current,
        // Appended by id, not blindly. A thread that arrived from another tab
        // between the compose starting and this post landing is already in
        // `current`, and pushing the same comment on top of it would render it
        // twice - once from the other tab's message and once from this write.
        [key]: [
          ...(current[key] ?? []).filter((entry) => entry.id !== comment.id),
          comment,
        ],
      }));
      // The whole thread travels, not the single comment: the thread only has a
      // dozen entries at most, and sending it complete means a tab that missed
      // an earlier message - newly opened, or reloaded mid-session - converges
      // on the same list instead of applying a delta to a thread it never had.
      broadcast({
        type: "comments",
        threadKey: key,
        thread: [...(commentsRef.current[key] ?? []), comment],
      });
    },
    [reviewer]
  );

  const handleAddComment = useCallback(
    (check: CheckItem, index: number, body: string) => {
      postCommentTo(decisionKey(check, index), body);
    },
    [postCommentTo]
  );

  /**
   * A comment written on the model, from a cloud's composer.
   *
   * Reuses `postCommentTo` rather than `handleAddComment`, because the cloud
   * layer hands back a thread key and not a check. The key comes from the
   * anchor table, so it is always one this audit vouches for.
   */
  const handleAddAnnotation = useCallback(
    (body: string, threadKey: string) => {
      postCommentTo(threadKey, body);
    },
    [postCommentTo]
  );

  const handleDeleteComment = useCallback(
    (check: CheckItem, index: number, id: string) => {
      const key = decisionKey(check, index);
      const thread = (commentsRef.current[key] ?? []).filter(
        (comment) => comment.id !== id
      );
      setComments((current) => {
        const next = { ...current };
        if (thread.length > 0) next[key] = thread;
        else delete next[key];
        return next;
      });
      broadcast({ type: "comments", threadKey: key, thread });
    },
    []
  );

  const handleSaveReviewer = useCallback((next: Reviewer) => {
    setReviewer(next);
    saveReviewer(next);
  }, []);

  // ------------------------------- Team chat -------------------------------
  //
  // The audit-wide channel. It is a comment thread like any other, keyed by
  // `teamChannelKey()` instead of by a finding, so it inherits the existing
  // persistence, cross-tab broadcast and reconcile-on-load behaviour rather
  // than growing a second store that could drift from the first.

  const chatThread = comments[teamChannelKey()] ?? [];

  const postChatMessage = useCallback(
    (body: string) => {
      const comment: ReviewComment = {
        id: makeId(),
        author: reviewer.name,
        role: reviewer.role,
        body,
        createdAt: new Date().toISOString(),
        viewpoint: captureViewpoint() ?? undefined,
      };
      const key = teamChannelKey();
      // Appended by id for the same reason `handleAddComment` does: a message
      // that arrived from another tab between the compose starting and this
      // post landing is already in `current`, and pushing a duplicate on top of
      // it would render twice.
      const thread = [
        ...(commentsRef.current[key] ?? []).filter(
          (entry) => entry.id !== comment.id
        ),
        comment,
      ];
      setComments((current) => ({ ...current, [key]: thread }));
      broadcast({ type: "comments", threadKey: key, thread });
    },
    [reviewer]
  );

  const deleteChatMessage = useCallback((id: string) => {
    const key = teamChannelKey();
    const thread = (commentsRef.current[key] ?? []).filter(
      (comment) => comment.id !== id
    );
    setComments((current) => {
      const next = { ...current };
      if (thread.length > 0) next[key] = thread;
      else delete next[key];
      return next;
    });
    broadcast({ type: "comments", threadKey: key, thread });
  }, []);

  /**
   * Switch the identity comments are posted as.
   *
   * The demo's counterpart to opening a second browser window as another
   * discipline. Only the role changes: the name is the reviewer's own, set once
   * in the identity dialog, and rewriting it here would silently rename every
   * comment they had already posted under the old identity.
   */
  const handleRoleChange = useCallback((role: string) => {
    setReviewer((current) => {
      const updated = { ...current, role };
      saveReviewer(updated);
      return updated;
    });
  }, []);

  /**
   * Fly the camera to a pose another user attached to their comment.
   *
   * The nonce is what makes clicking the same message twice work: the request
   * object is compared by identity in the viewer, so an unchanged pose would be
   * the same instruction and the second click would do nothing.
   */
  const handleLookAtViewpoint = useCallback((viewpoint: Viewpoint) => {
    cameraNonceRef.current += 1;
    setCameraRequest({
      position: viewpoint.position,
      target: viewpoint.target,
      nonce: cameraNonceRef.current,
    });
  }, []);

  /** Release the camera request once the viewer has arrived at it. */
  const handleCameraRequestApplied = useCallback(
    () => setCameraRequest(null),
    []
  );

  const toggleVisibility = useCallback((partId: string) => {
    setHiddenParts((current) =>
      current.includes(partId)
        ? current.filter((id) => id !== partId)
        : [...current, partId]
    );
  }, []);

  const showAll = useCallback(() => {
    setHiddenParts([]);
    setIsolatedPartId(null);
  }, []);

  const progress = useMemo(
    () => reviewProgress(result?.audit.checks ?? [], decisions),
    [result, decisions]
  );

  /**
   * The model(s) this audit was run against.
   *
   * A federated audit has two source files and the report header has one field
   * to name them, so both are named there. Citing only the first would make the
   * exported sign-off record claim a single-model audit that never happened.
   */
  const sourceName = useMemo(
    () =>
      secondaryFile
        ? `${file?.name ?? "model"} + ${secondaryFile.name}`
        : file?.name ?? "model",
    [file, secondaryFile]
  );

  const report = useMemo(() => {
    if (!result) return null;
    return buildReport({
      result,
      decisions,
      comments,
      reviewer,
      fileName: sourceName,
      requirements,
    });
  }, [result, decisions, comments, reviewer, sourceName, requirements]);

  /**
   * Export is gated on a complete review. An exported sign-off record that
   * silently omits half the findings would misrepresent the review as finished,
   * which is the one thing a sign-off document must not do. Confirming once sets
   * `exportWarning`; exporting again with it set proceeds.
   */
  const ensureReviewComplete = useCallback((): boolean => {
    if (!report) return false;
    const unreviewed = unreviewedFindings(report);
    if (unreviewed.length === 0) return true;
    setExportWarning(
      `${unreviewed.length} of ${report.progress.total} finding${
        report.progress.total === 1 ? "" : "s"
      } have not been reviewed. Export again to include it as an incomplete review, or review the remaining findings first.`
    );
    return false;
  }, [report]);

  const handleExportJson = useCallback(() => {
    if (!report) return;
    if (exportWarning && unreviewedFindings(report).length > 0) {
      downloadJson(
        reportToJson(report),
        reportFileName(report.fileName, "json")
      );
      setExportWarning(null);
      return;
    }
    if (!ensureReviewComplete()) return;
    downloadJson(reportToJson(report), reportFileName(report.fileName, "json"));
  }, [report, exportWarning, ensureReviewComplete]);

  const handlePrint = useCallback(() => {
    if (!report) return;
    if (exportWarning && unreviewedFindings(report).length > 0) {
      setExportWarning(null);
      window.print();
      return;
    }
    if (!ensureReviewComplete()) return;
    window.print();
  }, [report, exportWarning, ensureReviewComplete]);

  const showWorkbench = result !== null && !loading;

  return (
    <>
      {!showWorkbench && (
        <main id="app-root" className="print:hidden">
          {loading ? (
            <LoadingTelemetry
              fileName={sourceName}
              elapsedMs={elapsedMs}
              onCancel={cancelAudit}
            />
          ) : (
            <IntakeView
              presetId={presetId}
              pendingPreset={pendingPreset}
              presetError={presetError}
              file={file}
              secondaryFile={secondaryFile}
              activeSlot={activeSlot}
              requirements={requirements}
              error={error}
              draggingSlot={draggingSlot}
              tab={requirementTab}
              standardName={standardName}
              standardError={standardError}
              loading={loading}
              inputRef={inputRef}
              secondaryInputRef={secondaryInputRef}
              standardInputRef={standardInputRef}
              onAcceptFile={acceptFile}
              onRemoveFile={removeFile}
              onDragStateChange={handleDragStateChange}
              onFocusSlot={setActiveSlot}
              onRequirementsChange={(value) => {
                setRequirements(value);
                // Editing the text breaks the link to the preset it came from,
                // so the active chip must stop claiming this spec is that preset.
                setPresetId(null);
                // Likewise the standard: the field no longer holds what was read
                // from it once the reviewer has edited that text.
                setStandardName(null);
              }}
              onTabChange={setRequirementTab}
              onAcceptStandard={acceptStandard}
              onClearStandard={clearStandard}
              onChoosePreset={choosePreset}
              onSubmit={handleSubmit}
            />
          )}
        </main>
      )}

      {showWorkbench && result && (
        <div
          id="app-root"
          className="flex h-screen flex-col overflow-hidden bg-slate-100 print:hidden"
        >
          {/* ------------------------------ Header (48px) ------------------------------ */}
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-3">
            <BrandMark />
            <h1 className="hidden shrink-0 text-sm font-semibold tracking-tight text-slate-900 sm:block">
              CAD Compliance Auditor
            </h1>

            <span className="flex min-w-0 items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1">
              <FileBox className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span className="truncate font-mono text-[11px] text-slate-700">
                {sourceName}
              </span>
            </span>

            <StatusPill
              status={result.audit.overall_status}
              failing={
                result.audit.checks.filter((check) => check.status === "FAIL")
                  .length
              }
              className="shrink-0"
            />

            {/* Auto margins rather than justify-between: the free space splits
                around the progress block, so the actions stay right-aligned even
                when the progress block is hidden at narrow widths. */}
            <div className="mx-auto hidden min-w-0 items-center gap-3 px-2 lg:flex">
              <CheckCheck
                className={
                  "h-4 w-4 shrink-0 " +
                  (progress.complete ? "text-emerald-600" : "text-slate-400")
                }
              />
              <div className="min-w-0">
                <p className="whitespace-nowrap text-[11px] font-medium text-slate-700">
                  Reviewed {progress.reviewed} of {progress.total}
                  {progress.complete ? " — complete" : ""}
                </p>
                <div className="mt-1 flex h-1.5 w-40 overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="bg-emerald-500"
                    style={{
                      width: `${
                        progress.total
                          ? (progress.accepted / progress.total) * 100
                          : 0
                      }%`,
                    }}
                  />
                  <div
                    className="bg-amber-500"
                    style={{
                      width: `${
                        progress.total
                          ? (progress.modified / progress.total) * 100
                          : 0
                      }%`,
                    }}
                  />
                  <div
                    className="bg-rose-500"
                    style={{
                      width: `${
                        progress.total
                          ? (progress.rejected / progress.total) * 100
                          : 0
                      }%`,
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-2">
              <ExportMenu
                onExportJson={handleExportJson}
                onPrint={handlePrint}
                disabled={!report}
              />
              <button
                type="button"
                onClick={reset}
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 hover:text-slate-900"
              >
                <Plus className="h-3.5 w-3.5" />
                New Audit
              </button>
            </div>
          </header>

          {exportWarning && (
            <div className="flex shrink-0 items-start gap-2.5 border-b border-amber-500/30 bg-amber-50 px-3 py-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <p className="text-xs leading-relaxed text-amber-900">
                {exportWarning}
              </p>
            </div>
          )}

          {/* --------------------- Full-size viewer with docked overlays --------------------- */}
          <div className="relative min-h-0 flex-1">
            <CADViewer
              modelUrl={
                result.models?.disciplineA?.model_url ?? result.model_url
              }
              // A federated response gives each discipline its own GLB so the
              // two can be toggled apart; a single-model response has no
              // `models` and renders one group, exactly as before.
              secondaryModelUrl={result.models?.disciplineB?.model_url ?? null}
              disciplineSubtitles={[
                DISCIPLINE_SLOTS[0].label,
                DISCIPLINE_SLOTS[1].label,
              ]}
              failedParts={failedParts}
              components={result.cad_metrics.components}
              checks={result.audit.checks}
              // The geometric pre-check, so a clash beacon can sit at the
              // intersection of the two colliding solids rather than at the
              // centre of one of them. The audit response carries no per-check
              // coordinate; this is where the real one lives.
              clash={result.clash}
              selectedPartId={selectedPartId}
              hiddenParts={hiddenParts}
              isolatedPartId={isolatedPartId}
              selectedCheckIndex={selectedCheckIndex}
              focusCamera={cameraRequest}
              onFocusCameraApplied={handleCameraRequestApplied}
              onSelectPart={handleViewerSelect}
              onOpenFinding={handlePinOpenFinding}
              onCloseFinding={handleCloseFinding}
              onAnchorsResolved={handleAnchorsResolved}
              annotationStacks={annotationStacks}
              openAnnotationId={openAnnotationId}
              onOpenAnnotation={handleOpenAnnotation}
              onCloseAnnotation={handleCloseAnnotation}
              onAddAnnotation={handleAddAnnotation}
              // The docked panels sit over the canvas at a higher z-index, so
              // the clouds have to know how much of the viewport each one is
              // covering or a card near an edge is clamped behind it.
              panelInsets={panelInsets}
              className="absolute inset-0"
              fill
            />

            {/* Docked inspector, on the LEFT.

                It was on the right, and moved to match the reference layout.
                The reason it reads better there is the reading order: the
                findings are the thing being worked through, and a reviewer's
                eye starts at the left edge. The model then sits to their right
                with the chat rail beyond it, so the three columns run
                finding -> geometry -> conversation, which is the order the
                reviewer uses them in.

                One panel with two tabs rather than two separate drawers: the
                feedback feed and the model tree are two views of the same
                model, and a reviewer who isolates a part in the tree wants the
                findings for it immediately - not to close one drawer and open
                another. Rendered after the viewer so the tab strip stays
                clickable where the canvas would extend under it.

                The closed state slides out to the LEFT (negative translate),
                since the left edge is now the hidden side. */}
            <div
              className={
                "absolute bottom-3 left-3 top-3 z-10 flex w-[460px] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl shadow-slate-900/10 transition-transform duration-200 " +
                (activePanel !== null
                  ? "translate-x-0"
                  : "pointer-events-none -translate-x-[calc(100%+1.5rem)]")
              }
            >
              {activePanel !== null && (
                <>
                  <div
                    role="tablist"
                    aria-label="Inspector panel"
                    className="flex shrink-0 items-center gap-1 border-b border-slate-200 px-2 pt-2"
                  >
                    {(
                      [
                        {
                          key: "findings",
                          label: "Feedback & AutoReview",
                          Icon: PanelRight,
                          count: result.audit.checks.length,
                        },
                        {
                          key: "tree",
                          label: "Model Tree",
                          Icon: PanelLeft,
                          count: result.cad_metrics.solid_count,
                        },
                      ] as const
                    ).map(({ key, label, Icon, count }) => {
                      const active = activePanel === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => setActivePanel(key)}
                          className={
                            "flex min-w-0 items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-2 text-[11px] font-semibold transition " +
                            (active
                              ? "border-blue-700 text-blue-800"
                              : "border-transparent text-slate-500 hover:text-slate-800")
                          }
                        >
                          <Icon className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{label}</span>
                          <span
                            className={
                              "shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10px] font-bold " +
                              (active
                                ? "bg-blue-100 text-blue-800"
                                : "bg-slate-100 text-slate-500")
                            }
                          >
                            {count}
                          </span>
                        </button>
                      );
                    })}

                    <button
                      type="button"
                      onClick={() => setActivePanel(null)}
                      aria-label="Close inspector panel"
                      className="mb-1 ml-auto shrink-0 rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  {activePanel === "findings" ? (
                    <ReviewStream
                      checks={result.audit.checks}
                      decisions={decisions}
                      comments={comments}
                      reviewer={reviewer}
                      selectedPartId={selectedPartId}
                      selectedCheckIndex={selectedCheckIndex}
                      shouldScroll={scrollToRow}
                      summary={result.audit.summary}
                      solidCount={result.cad_metrics.solid_count}
                      hiddenCount={hiddenParts.length}
                      isolatedLabel={
                        isolatedPartId ? partLabel(isolatedPartId) : null
                      }
                      receivedAt={receivedAt}
                      onSelectPart={handleRowSelect}
                      onDecide={handleDecide}
                      onClearDecision={handleClearDecision}
                      onAddComment={handleAddComment}
                      onDeleteComment={handleDeleteComment}
                      onOpenReviewerSettings={() => setReviewerOpen(true)}
                      onClose={() => setActivePanel(null)}
                      participants={participants}
                      onRoleChange={handleRoleChange}
                      onLook={handleLookAtViewpoint}
                    />
                  ) : (
                    <ModelTree
                      components={result.cad_metrics.components}
                      failedParts={failedParts}
                      selectedPartId={selectedPartId}
                      hiddenParts={hiddenParts}
                      isolatedPartId={isolatedPartId}
                      onSelectPart={handleViewerSelect}
                      onToggleVisibility={toggleVisibility}
                      onIsolate={setIsolatedPartId}
                      onShowAll={showAll}
                      className="flex min-h-0 flex-1 flex-col overflow-hidden p-3"
                      scrollBody={false}
                    />
                  )}
                </>
              )}
            </div>

            {/* Reopen handle. Sits outside the drawer so it stays reachable once
                the panel is closed. Moved to the left with the panel, and kept
                clear of the viewer's own bottom-left controls. */}
            {activePanel === null && (
              <button
                type="button"
                onClick={() => setActivePanel("findings")}
                className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                <PanelRight className="h-3.5 w-3.5" />
                Inspector
                {result.audit.checks.length > 0 && (
                  <span className="rounded-full bg-blue-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-blue-800">
                    {result.audit.checks.length}
                  </span>
                )}
              </button>
            )}

            {/* Team chat rail, on the right.

                This is the third column of the workbench: the findings on the
                left, the model in the middle, the conversation on the right.
                It holds the audit-wide channel rather than a finding's thread,
                which is what distinguishes it from the discussion inside each
                card - a question about the model belongs somewhere that is not
                attached to one of twenty-one findings. */}
            <div
              className={
                "absolute bottom-3 right-3 top-3 z-10 flex w-[340px] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl shadow-slate-900/10 transition-transform duration-200 " +
                (chatOpen
                  ? "translate-x-0"
                  : "pointer-events-none translate-x-[calc(100%+1.5rem)]")
              }
            >
              <TeamChat
                comments={chatThread}
                participants={participants}
                reviewer={reviewer}
                draft={chatDraft}
                activeFindings={result.audit.checks}
                onDraftChange={setChatDraft}
                onPost={postChatMessage}
                onDelete={deleteChatMessage}
                onLook={handleLookAtViewpoint}
                onClose={() => setChatOpen(false)}
              />
            </div>

            {/* The chat's open handle. Stays visible when the rail is closed so
                the channel is discoverable - a reviewer who never finds it will
                put an audit-wide question in a finding's thread instead, where
                the next reader will not look for it. */}
            {!chatOpen && (
              <button
                type="button"
                onClick={() => setChatOpen(true)}
                className="absolute right-3 top-3 z-10 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Team Chat
                {chatThread.length > 0 && (
                  <span className="rounded-full bg-blue-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-blue-800">
                    {chatThread.length}
                  </span>
                )}
              </button>
            )}
          </div>
        </div>
      )}

      {reviewerOpen && (
        <ReviewerSettings
          reviewer={reviewer}
          onSave={handleSaveReviewer}
          onClose={() => setReviewerOpen(false)}
        />
      )}

      {/* Rendered at all times but hidden on screen; globals.css reveals it only
          inside @media print, which is what turns window.print() into the PDF
          export without pulling in a PDF library. */}
      {report && (
        <div id="audit-report" aria-hidden>
          <AuditReport report={report} />
        </div>
      )}
    </>
  );
}
