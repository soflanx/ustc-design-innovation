import type { CSSProperties, ReactNode } from 'react';
import { readMarkdownSource, type CourseDocument, type CourseBlock } from '@/lib/course-document';
import { documentRecordIds, safeDocumentUrl, type CourseDocumentCatalog } from '@/lib/course-document-view';
import { CourseRecordView } from './course-record-view';
import { CourseMarkdownView } from './course-markdown-view';
import styles from './course-document-view.module.css';

const textColors: Record<string, string> = { default: 'inherit', gray: '#62686c', brown: '#765b48', red: '#a23e38', orange: '#97590b', yellow: '#846b14', green: '#326b47', blue: '#245f88', purple: '#7250a2', pink: '#a84472' };
const backgroundColors: Record<string, string> = { default: 'transparent', gray: '#f0f1f0', brown: '#f4eae3', red: '#fbe9e7', orange: '#fff0dd', yellow: '#fff6cc', green: '#e9f3e9', blue: '#e6f0f8', purple: '#f0eafa', pink: '#fbe9f1' };

type Inline = { type: string; text?: string; href?: string; styles?: Record<string, unknown>; content?: Inline[] };
function inlineContent(content: unknown): ReactNode {
  if (!Array.isArray(content)) return null;
  return (content as Inline[]).map((item, index) => {
    if (item.type === 'link') {
      const href = safeDocumentUrl(item.href);
      return href ? <a key={index} href={href} {...(href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{inlineContent(item.content)}</a> : <span key={index}>{inlineContent(item.content)}</span>;
    }
    if (item.type !== 'text') return null;
    const marks = item.styles ?? {};
    let text: ReactNode = item.text;
    if (marks.code) text = <code>{text}</code>;
    if (marks.bold) text = <strong>{text}</strong>;
    if (marks.italic) text = <em>{text}</em>;
    if (marks.underline) text = <u>{text}</u>;
    if (marks.strike) text = <s>{text}</s>;
    return <span key={index} style={{ color: textColors[String(marks.textColor ?? 'default')], backgroundColor: backgroundColors[String(marks.backgroundColor ?? 'default')] }}>{text}</span>;
  });
}

export function CourseDataView({ block, catalog, editing = false }: { block: CourseBlock; catalog: CourseDocumentCatalog; editing?: boolean }) {
  const kind = block.props.kind;
  if (kind !== 'assignments' && kind !== 'resources' && kind !== 'groups') return null;
  const items = documentRecordIds(block.props.ids).flatMap(id => catalog[kind].filter(item => item.id === id));
  if (!items.length) return null;
  const title = String(block.props.title || ({ assignments: '本次任务', resources: '本次资料', groups: '小组与项目' }[kind]));
  return <section className={styles.database} aria-label={title} data-course-database={kind}>
    <div className={styles.databaseHeading}><h2>{title}</h2><span>{items.length} 项</span></div>
    <div className={block.props.layout === 'cards' ? styles.cards : styles.rows}>{items.map(item => <CourseRecordView editing={editing} key={item.id} record={item} kind={kind} display={block.props.layout === 'cards' ? 'card' : 'link'}/>)}</div>
  </section>;
}

function blockStyle(block: CourseBlock): CSSProperties {
  const alignment = block.props.textAlignment;
  return {
    textAlign: ['left', 'center', 'right', 'justify'].includes(String(alignment)) ? alignment as CSSProperties['textAlign'] : undefined,
    color: textColors[String(block.props.textColor ?? 'default')],
    backgroundColor: backgroundColors[String(block.props.backgroundColor ?? 'default')],
  };
}

function Blocks({ blocks, catalog, titleBlockId, editing }: { blocks: CourseBlock[]; catalog: CourseDocumentCatalog; titleBlockId?: string | null; editing: boolean }) {
  const result: ReactNode[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const body = block.type === 'markdown' ? null : inlineContent(block.content);
    const children = block.children?.length ? <div className={styles.children}><Blocks blocks={block.children} catalog={catalog} titleBlockId={titleBlockId} editing={editing}/></div> : null;
    const attrs = { 'data-content-block': block.type, style: blockStyle(block) };
    if (block.type === 'bulletListItem' || block.type === 'numberedListItem' || block.type === 'checkListItem') {
      const listType = block.type;
      const items: ReactNode[] = [];
      do {
        const item = blocks[index];
        items.push(<li key={item.id} style={blockStyle(item)}>{listType === 'checkListItem' && <span className={styles.check} role="img" aria-label={item.props.checked ? '已勾选' : '未勾选'}>{item.props.checked ? '☑' : '☐'}</span>}<div>{inlineContent(item.content)}{!!item.children?.length && <div className={styles.children}><Blocks blocks={item.children} catalog={catalog} titleBlockId={titleBlockId} editing={editing}/></div>}</div></li>);
        index++;
      } while (index < blocks.length && blocks[index].type === listType);
      index--;
      result.push(listType === 'numberedListItem' ? <ol key={block.id} start={Number(block.props.start) || 1} className={styles.list}>{items}</ol> : <ul key={block.id} className={listType === 'checkListItem' ? styles.checkList : styles.list}>{items}</ul>);
      continue;
    }
    let node: ReactNode;
    switch (block.type) {
      case 'markdown': node = <div className={styles.markdown} {...attrs}><CourseMarkdownView source={readMarkdownSource(block)} catalog={catalog} editing={editing}/></div>; break;
      case 'heading': node = block.id === titleBlockId ? <h1 {...attrs} data-course-page-title>{body}</h1> : block.props.level === 3 ? <h4 {...attrs}>{body}</h4> : block.props.level === 2 ? <h3 {...attrs}>{body}</h3> : <h2 {...attrs}>{body}</h2>; break;
      case 'quote': node = <blockquote {...attrs}>{body}</blockquote>; break;
      case 'callout': node = <aside className={styles.callout} data-tone={block.props.tone || 'info'} {...attrs}><span className={styles.calloutIcon} aria-hidden="true">{block.props.tone === 'warning' ? '!' : block.props.tone === 'success' ? '✓' : 'i'}</span><div>{body}{children}</div></aside>; break;
      case 'toggle': node = <details className={styles.toggle} {...attrs}><summary>{String(block.props.title || '展开详细说明')}</summary><div>{body}{children}</div></details>; break;
      case 'image': {
        const url = safeDocumentUrl(block.props.url);
        node = url ? <figure className={styles.figure} style={{ textAlign: attrs.style.textAlign }}>
          {block.props.showPreview === false
            ? <a href={url} target="_blank" rel="noopener noreferrer">{String(block.props.name || block.props.caption || '查看图片')} ↗</a>
            : <img src={url} alt={String(block.props.caption || block.props.name || '课程图片')} loading="lazy" referrerPolicy="no-referrer" style={{ width: Number(block.props.previewWidth) > 0 ? Math.min(Number(block.props.previewWidth), 1600) : undefined }}/>}
          {block.props.caption && <figcaption>{String(block.props.caption)}</figcaption>}
        </figure> : null;
        break;
      }
      case 'courseData': node = <CourseDataView block={block} catalog={catalog} editing={editing}/>; break;
      case 'courseRecord': {
        const kind = block.props.kind;
        if (kind !== 'assignments' && kind !== 'resources' && kind !== 'groups' && kind !== 'pages') { node = null; break; }
        const record = catalog[kind]?.find(item => item.id === block.props.recordId);
        node = record ? <CourseRecordView editing={editing} record={record} kind={kind} display={block.props.display === 'card' ? 'card' : 'link'}/> : null;
        break;
      }
      case 'protected': result.push(<Blocks key={block.id} blocks={block.children ?? []} catalog={catalog} titleBlockId={titleBlockId} editing={editing}/>); continue;
      default: node = <p className={styles.paragraph} {...attrs}>{body || <br/>}</p>;
    }
    result.push(<div key={block.id} className={styles.block} data-block-type={block.type}>{node}{block.type !== 'callout' && block.type !== 'toggle' && children}</div>);
  }
  return result;
}

/** Plain React rendering is shared by the server reader and the editing preview. */
export function CourseDocumentView({ document, catalog, editing = false }: { document: CourseDocument; catalog: CourseDocumentCatalog; editing?: boolean }) {
  return <div className={styles.document} data-course-document><Blocks blocks={document.blocks} catalog={catalog} titleBlockId={document.titleBlockId} editing={editing}/></div>;
}
