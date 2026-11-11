import type { GroupPageContent } from './management';

export type GroupEdit = {
  baseline: GroupPageContent;
  title: string;
  body: string;
  conflict: GroupPageContent | null;
  checkedRevision: number | null;
  restoredRevision: number | null;
};

export function startGroupEdit(baseline: GroupPageContent): GroupEdit {
  return { baseline, title: baseline.title, body: baseline.body, conflict: null, checkedRevision: null, restoredRevision: null };
}

export function hasGroupDraftChanges(edit: GroupEdit) {
  if (edit.title !== edit.baseline.title || edit.body !== edit.baseline.body) return true;
  // Restoring the original text is still an intentional edit against a newer group record.
  return edit.restoredRevision !== null && !!edit.conflict && edit.conflict.revision > edit.baseline.revision;
}
