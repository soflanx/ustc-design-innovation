'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { saveCourseNewsDraftAction } from '@/lib/course-news-actions';
import styles from './course-news.module.css';

type EditTarget = { postId: string; revision: number };
type NewsText = { title: string; excerpt: string; body: string };
type CoverText = { alt: string; caption: string };
type CurrentCover = CoverText & { src: string; width: number; height: number; legacy: boolean };

const maxCoverBytes = 5 * 1024 * 1024;

export function CourseNewsEditor({ offeringId, viewerId, target, requestId, initial, cover, latestHref }: {
  offeringId: string;
  viewerId: string;
  target: EditTarget | null;
  requestId: string;
  initial: NewsText;
  cover?: CurrentCover;
  latestHref: string;
}) {
  const router = useRouter();
  // Keep the opening revision and request ID when the same form receives new props.
  const original = useRef({ target, requestId, text: initial, cover });
  const saved = original.current;
  const currentCover = saved.cover;
  const [text, setText] = useState(initial);
  const [coverText, setCoverText] = useState<CoverText>({ alt: cover?.alt ?? '', caption: cover?.caption ?? '' });
  const [replacement, setReplacement] = useState<(CoverText & { file: File }) | null>(null);
  const [removeCover, setRemoveCover] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const savedAndLeaving = useRef(false);
  const dirty = !!replacement || removeCover || text.title !== saved.text.title || text.excerpt !== saved.text.excerpt
    || text.body !== saved.text.body || coverText.alt !== (currentCover?.alt ?? '') || coverText.caption !== (currentCover?.caption ?? '');
  const imageText = replacement ?? coverText;
  const canDescribeImage = !!replacement || (currentCover && !currentCover.legacy && !removeCover);

  useEffect(() => {
    if (!dirty) return;
    function protectUnload(event: BeforeUnloadEvent) {
      if (savedAndLeaving.current) return;
      event.preventDefault();
      event.returnValue = '';
    }
    function protectNavigation(event: MouseEvent) {
      if (savedAndLeaving.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey
        || event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLAnchorElement>('a[href]');
      if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
      const next = new URL(link.href);
      if (next.origin !== location.origin || (next.pathname === location.pathname && next.search === location.search)) return;
      if (!window.confirm('新闻还有未保存的修改。放弃修改并离开吗？')) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
    window.addEventListener('beforeunload', protectUnload);
    document.addEventListener('click', protectNavigation, true);
    return () => {
      window.removeEventListener('beforeunload', protectUnload);
      document.removeEventListener('click', protectNavigation, true);
    };
  }, [dirty]);

  function updateImageText(patch: Partial<CoverText>) {
    if (replacement) setReplacement({ ...replacement, ...patch });
    else setCoverText({ ...coverText, ...patch });
    setError('');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || savedAndLeaving.current) return;
    if (replacement && replacement.file.size > maxCoverBytes) {
      setError('配图超过 5 MiB，请选择较小的图片。');
      return;
    }
    const form = event.currentTarget;
    const data = new FormData(form);
    if (replacement) data.set('cover', replacement.file, replacement.file.name);
    else data.delete('cover');
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const result = await saveCourseNewsDraftAction(offeringId, viewerId, saved.target, saved.requestId, {}, data);
      if (!form.isConnected) return;
      if (!result.redirectTo) {
        setError(result.error || '暂未确认保存结果。当前修改仍在，可以重试。');
        return;
      }
      savedAndLeaving.current = true;
      router.replace(result.redirectTo);
    } catch {
      setError('暂未确认保存结果。当前修改仍在，可以重试。');
    } finally {
      busy.current = false;
      if (!savedAndLeaving.current) setPending(false);
    }
  }

  return <form method="post" className={styles.editor} aria-label={saved.target ? '编辑新闻' : '新建新闻'} onSubmit={save}>
    <fieldset className={styles.fields} disabled={pending}>
      <label className="form-field">标题
        <input name="title" required maxLength={120} value={text.title}
          onChange={event => { setText({ ...text, title: event.target.value }); setError(''); }}/>
      </label>
      <label className="form-field">摘要（选填）
        <input name="excerpt" maxLength={300} value={text.excerpt}
          onChange={event => { setText({ ...text, excerpt: event.target.value }); setError(''); }}/>
      </label>
      <label className="form-field">正文
        <textarea name="body" rows={10} maxLength={12000} value={text.body}
          onChange={event => { setText({ ...text, body: event.target.value }); setError(''); }}/>
      </label>
      <section className={styles.coverFields} aria-label="新闻配图">
        {currentCover && !replacement && !removeCover && <figure>
          <img src={currentCover.src} alt={coverText.alt} width={currentCover.width} height={currentCover.height}/>
          {coverText.caption && <figcaption>{coverText.caption}</figcaption>}
        </figure>}
        <div className="form-field">
          <label htmlFor="news-cover">{currentCover ? '更换配图' : '配图（选填）'}</label>
          <input id="news-cover" ref={fileInput} name="cover" type="file" accept="image/jpeg,image/png,image/webp"
            aria-describedby="news-cover-help" onChange={event => {
              const file = event.currentTarget.files?.[0];
              if (file) {
                setReplacement(previous => ({ file, alt: previous?.alt ?? '', caption: previous?.caption ?? '' }));
                setRemoveCover(false);
              } else setReplacement(null);
              setError('');
            }}/>
          <p id="news-cover-help" className="field-help">JPEG、PNG 或 WebP，最大 5 MiB。</p>
        </div>
        {replacement ? <div className={styles.coverControl}>
          <button type="button" className="link-button" onClick={() => {
            if (fileInput.current) fileInput.current.value = '';
            setReplacement(null);
            setError('');
          }}>{currentCover ? '取消更换配图' : '移除所选图片'}</button>
        </div> : currentCover && <div className={styles.coverControl}>
          <label><input name="removeCover" type="checkbox" checked={removeCover} onChange={event => {
            setRemoveCover(event.target.checked);
            setError('');
          }}/>移除现有配图</label>
        </div>}
        {canDescribeImage && <>
          <label className="form-field">图片替代文字
            <input name="coverAlt" required maxLength={180} value={imageText.alt}
              onChange={event => updateImageText({ alt: event.target.value })}/>
          </label>
          <label className="form-field">图片说明（选填）
            <input name="coverCaption" maxLength={180} value={imageText.caption}
              onChange={event => updateImageText({ caption: event.target.value })}/>
          </label>
        </>}
      </section>
    </fieldset>
    {error && <div className="notice error" role="alert">
      <p>{error}</p>
      <a href={latestHref} target="_blank" rel="noopener noreferrer">{saved.target ? '在新标签页查看最新版' : '在新标签页查看本期新闻'}</a>
    </div>}
    <div><button className="button primary" type="submit" disabled={pending}>{pending ? '正在保存…' : '保存并预览'}</button></div>
  </form>;
}
