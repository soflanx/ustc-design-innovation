import { authoredPageSnapshot } from '@/lib/course-authored-page';
import { ensureCoursePageTitle, type CourseBlock } from '@/lib/course-document';
import { CourseDocumentView } from './course-document-view';
import { CourseFocusEditor, type CourseFocusEditorProps } from './course-focus-editor';
import styles from './current-teaching.module.css';

type CourseAuthoredPageProps = Omit<CourseFocusEditorProps, 'focus'> & {
  page: CourseFocusEditorProps['focus'];
  canEdit: boolean;
  externalTitle?: boolean;
  fallbackTitle?: string;
};

function withoutTitle(blocks: CourseBlock[], id: string): CourseBlock[] {
  return blocks.flatMap(block => {
    const children = block.children?.length ? withoutTitle(block.children, id) : block.children;
    return block.id === id ? children ?? [] : [{ ...block, children }];
  });
}

export function CourseAuthoredPage({ page, canEdit, externalTitle = false, fallbackTitle, ...editor }: CourseAuthoredPageProps) {
  // Each service includes draft content only for the teaching team.
  const reading = page?.publishedAt ? page : page?.draft;
  const archived = editor.courseStatus === 'ARCHIVED';
  const document = reading ? ensureCoursePageTitle(reading.document, reading.title) : null;
  const body = document?.titleBlockId && externalTitle
    ? { ...document, titleBlockId: null, blocks: withoutTitle(document.blocks, document.titleBlockId) }
    : document;
  return (
    <section className={styles.brief} aria-label="当前教学内容" data-course-authored-page data-course-focus={reading ? 'set' : 'empty'}>
      {canEdit && <CourseFocusEditor key={JSON.stringify([editor.authorId, editor.offeringId, editor.subpageId])} {...editor} focus={page ? authoredPageSnapshot(page) : null}/>}
      <div data-course-reading>
        {body ? <>
          {!page?.publishedAt && <p className={styles.notice}>此页为草稿，仅教学团队可见。</p>}
          <CourseDocumentView document={body} catalog={editor.catalog}/>
        </> : <>
          {!externalTitle && <h1>{fallbackTitle ?? '课程内容'}</h1>}
          <p className={styles.emptyDescription}>{canEdit
            ? '写下教学安排，按需加入图片、课次、作业或资料。'
            : archived ? '本学期没有发布教学说明。' : '课程说明待发布。'}</p>
        </>}
      </div>
    </section>
  );
}
