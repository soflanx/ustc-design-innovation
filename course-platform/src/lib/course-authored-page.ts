import type { CourseFocusContent } from './course-focus';

// Source-specific keys and home task indexes do not belong in the page editor.
export type CourseAuthoredSnapshot = Pick<CourseFocusContent, 'title' | 'document' | 'draft' | 'publishedAt' | 'revision'>;
export function authoredPageSnapshot({ title, document, publishedAt, revision, draft }: CourseAuthoredSnapshot): CourseAuthoredSnapshot {
  return { title, document, publishedAt, revision, ...(draft ? { draft } : {}) };
}
