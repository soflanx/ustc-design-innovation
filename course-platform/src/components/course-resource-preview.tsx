'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './course-resource-preview.module.css';

type Preview = {
  kind: 'pdf' | 'image' | 'text' | 'download' | 'link';
  name: string;
  text?: string;
  truncated?: boolean;
};

function ResourcePreviewDialog({ href, previewHref, title, onClose }: {
  href: string; previewHref: string; title: string; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [mediaError, setMediaError] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`${previewHref}?meta=1`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 404 || response.status === 401 || response.status === 403
          ? '这份资料现在无法访问，请关闭预览并刷新页面。' : '暂时无法加载预览，请稍后重试。');
        const result = await response.json() as Preview;
        if (!['pdf', 'image', 'text', 'download', 'link'].includes(result.kind)) throw new Error('暂时无法加载预览。');
        if (!controller.signal.aborted) setPreview(result);
      } catch (issue) {
        if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '暂时无法加载预览。');
      }
    }
    void load();
    return () => controller.abort();
  }, [previewHref]);

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={headingId} data-course-resource-preview
    onKeyDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); onClose(); }} onClose={onClose}>
    <header className={styles.header}>
      <div><h2 id={headingId}>{title}</h2>{preview?.name && preview.name !== title && <p>{preview.name}</p>}</div>
      <button type="button" className={styles.close} onClick={onClose} aria-label="关闭资料预览">关闭</button>
    </header>
    <div className={styles.content}>
      {error ? <p role="alert" className={styles.message}>{error}</p> : !preview ? <p role="status" className={styles.message}>正在加载资料…</p> : <>
        {preview.kind === 'pdf' && <iframe className={styles.pdf} src={previewHref} title={`${title} PDF 预览`}/>}
        {preview.kind === 'image' && (mediaError ? <p className={styles.message}>图片暂时无法显示，请打开文件查看。</p>
          // Native image loading preserves the file route's session checks.
          // eslint-disable-next-line @next/next/no-img-element
          : <img className={styles.image} src={previewHref} alt={title} onError={() => setMediaError(true)}/>)}
        {preview.kind === 'text' && <><pre className={styles.text}>{preview.text || '（空白文件）'}</pre>
          {preview.truncated && <p className={styles.message}>这里只显示部分内容，下载文件可阅读全文。</p>}</>}
        {preview.kind === 'download' && <p className={styles.message}>此格式暂不支持页内预览，可以下载后查看。</p>}
        {preview.kind === 'link' && <p className={styles.message}>这份资料是外部网页，请打开原站查看。</p>}
      </>}
    </div>
    {preview && !error && <footer className={styles.footer}>
      {preview.kind === 'pdf' && <span>如未显示，请打开文件查看。</span>}
      <a href={href} target="_blank" rel="noopener noreferrer">{preview.kind === 'link' ? '打开原站' : preview.kind === 'pdf' ? '打开文件' : '下载文件'}</a>
    </footer>}
  </dialog>;
}

export function CourseResourcePreview({ href, title, className }: { href: string; title: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // Only known, same-origin course file routes can supply a preview.
  const match = href.match(/^(\/courses\/[^/?#]+\/resources\/[^/?#]+)\/open(?:\?[^#]*)?$/);
  if (!match) return null;
  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  return <>
    <button ref={trigger} type="button" className={[styles.trigger, className].filter(Boolean).join(' ')}
      aria-label={`预览${title}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>预览</button>
    {open && createPortal(<ResourcePreviewDialog href={href} previewHref={`${match[1]}/preview`} title={title} onClose={close}/>, document.body)}
  </>;
}
