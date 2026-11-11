import { createMarkdownBlock, readMarkdownSource, type CourseBlock } from './course-document';

// BlockNote's inline schema normalizes whitespace, so in layout mode we carry
// the literal Markdown source as an opaque property on a movable block.
export function markdownLayoutBlocks(blocks: CourseBlock[], toLayout: boolean): CourseBlock[] {
  return blocks.map(block => {
    const children = markdownLayoutBlocks(block.children ?? [], toLayout);
    if (block.type !== 'markdown') return { ...block, children };
    if (toLayout) return { ...block, props: { ...block.props, source: readMarkdownSource(block) }, content: undefined, children };
    const { source, ...format } = block.props;
    return { ...createMarkdownBlock(block.id, String(source ?? '')), props: format, children };
  });
}
