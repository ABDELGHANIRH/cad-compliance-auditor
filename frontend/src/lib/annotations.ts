import type { CheckItem, CommentMap, ViewerAnnotation } from '@/types/audit';

/**
 * The coordinate key a cloud and a marker are grouped by.
 *
 * Deliberately the same rounding `clusterBeacons` uses in the viewer, and
 * duplicated rather than imported because that one lives in a `'use client'`
 * component module and this one is pure. Two decimals: every model is normalised
 * to ~50 world units on its largest dimension, so this merges two anchors that
 * are the same defect point up to float noise while leaving two defects on
 * distinct parts of one solid apart.
 *
 * The two must agree or a cloud drifts off the marker it belongs to - a cloud
 * on one cluster and a numbered marker on the neighbouring one reads as a
 * rendering bug rather than as a finding.
 */
export function anchorKey(anchor: [number, number, number]): string {
  return `${anchor[0].toFixed(2)}|${anchor[1].toFixed(2)}|${anchor[2].toFixed(2)}`;
}

/**
 * Every comment that has a place on the model, grouped by that place.
 *
 * The flattening step between the comment store and the viewer. Comments are
 * keyed by finding identity and know nothing about coordinates; the viewer knows
 * coordinates and nothing about comments. This is where the two are joined, and
 * it is a `lib` module rather than a memo inside the viewer for the reason the
 * marker layer records about itself: the layer is deliberately free of
 * `CheckItem`, and it should stay free of `CommentMap` too. It is handed a
 * prepared stack, not the raw store.
 *
 * A comment is dropped in two cases, and both are deliberate:
 *
 *   - Its thread key has no entry in `anchors`. That covers team-channel chat,
 *     which is keyed on the audit rather than on a finding, and any finding the
 *     viewer could not resolve to a coordinate. A cloud has to sit *somewhere on
 *     the model* to be worth drawing; the panels still show these.
 *   - Its own `anchor` is absent. A comment written with nothing open - from the
 *     feed with the viewer untouched - carries no coordinate, and a pose without
 *     a point would put a cloud on a part the author never looked at.
 *
 * The stack is ordered oldest first, which is the order the thread reads in the
 * card, so the cloud's count and the panel it opens cannot disagree.
 */
export function commentAnnotations(
  comments: CommentMap,
  anchors: Map<string, [number, number, number]>,
): ViewerAnnotation[] {
  if (anchors.size === 0) return [];

  const stacks: ViewerAnnotation[] = [];

  for (const [key, anchor] of anchors) {
    const thread = comments[key];
    if (!thread || thread.length === 0) continue;

    for (const comment of thread) {
      // The comment's own anchor wins when it has one. A thread can span a
      // reviewer's whole inspection, and a comment written while looking at one
      // clash should not be dragged to wherever the finding resolves last.
      const point = comment.anchor ?? anchor;
      stacks.push({
        id: comment.id,
        body: comment.body,
        author: comment.author,
        role: comment.role,
        createdAt: comment.createdAt,
        anchor: point,
        threadKey: key,
      });
    }
  }

  return stacks;
}

/**
 * Collapse a set of annotations into one entry per coordinate.
 *
 * Separate from `annotationStacks` because the two answer different questions
 * and change for different reasons: the flatten is a function of the comment
 * store, this is a function of the layout's tolerance for crowding. Keeping them
 * apart means a reviewer posting a comment does not re-run the grouping, and
 * changing the crowding rule does not touch the comment join.
 *
 * The representative is the oldest comment at the coordinate - the one whose
 * words are at the top of the card the cloud opens, so the chip and the panel
 * agree about which finding this pile is about.
 */
export interface AnnotationStack {
  /** The comment shown when the stack is rendered as a single cloud. */
  lead: ViewerAnnotation;
  /** Every comment at this coordinate, oldest first. */
  members: ViewerAnnotation[];
}

export function groupAnnotations(annotations: ViewerAnnotation[]): AnnotationStack[] {
  const byAnchor = new Map<string, AnnotationStack>();

  for (const annotation of annotations) {
    const key = anchorKey(annotation.anchor);
    const existing = byAnchor.get(key);
    if (existing) {
      existing.members.push(annotation);
      continue;
    }
    byAnchor.set(key, { lead: annotation, members: [annotation] });
  }

  return [...byAnchor.values()];
}

