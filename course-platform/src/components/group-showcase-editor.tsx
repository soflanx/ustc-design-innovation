'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { saveShowcaseDraftAction, type ShowcaseDraftConflict } from '@/lib/group-showcase-actions';
import {
  showcaseDraftLimits as limits, showcaseSelectionKey,
  type ShowcaseDraft, type ShowcaseSelection, type ShowcaseSource, type ShowcaseSourceKind,
} from '@/lib/group-showcase-contract';
import styles from './group-showcase-editor.module.css';

const sourceKinds: { kind: ShowcaseSourceKind; label: string; empty: string }[] = [
  { kind: 'ACTIVITY', label: '过程记录', empty: '本组还没有过程记录。' },
  { kind: 'SUBMISSION', label: '作业成果', empty: '本组还没有交回作业成果。' },
];

function selectionMaterial(sources: Map<string, ShowcaseSource>, selection: ShowcaseSelection) {
  const source = sources.get(JSON.stringify([selection.source, selection.sourceId]));
  const file = source?.files.find(item => item.id === selection.fileId);
  const available = Boolean(selection.fileId === null ? source?.body.trim() : file);
  return { source, file, available };
}

export function GroupShowcaseEditor({ offeringId, groupId, viewerId, initial, sources, editHref, previewHref }: {
  offeringId: string;
  groupId: string;
  viewerId: string;
  initial: ShowcaseDraft & { revision: number };
  sources: ShowcaseSource[];
  editHref: string;
  previewHref: string;
}) {
  const router = useRouter();
  const { revision: initialRevision, ...initialDraft } = initial;
  const [draft, setDraft] = useState(initialDraft);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState({ revision: initialRevision, draft: initialDraft });
  const [conflict, setConflict] = useState<ShowcaseDraftConflict | null>(null);
  const [checkedRevision, setCheckedRevision] = useState<number | null>(null);
  const [unavailableKeys, setUnavailableKeys] = useState(() => new Set<string>());
  const busy = useRef(false);
  const conflictHeading = useRef<HTMLHeadingElement>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved.draft);
  const selectedKeys = new Set(draft.selections.map(showcaseSelectionKey));
  const latest = conflict?.current;
  const canSave = !latest || checkedRevision === latest.revision;
  const pickerSources = conflict?.sources ?? sources;
  const sourceIndex = new Map(pickerSources.map(source => [JSON.stringify([source.source, source.id]), source]));
  const originalSourceIndex = conflict ? new Map(sources.map(source => [JSON.stringify([source.source, source.id]), source])) : sourceIndex;
  const hasUnavailableSelections = draft.selections.some(selection => unavailableKeys.has(showcaseSelectionKey(selection)));

  useEffect(() => {
    if (conflict) conflictHeading.current?.focus();
  }, [conflict]);

  useEffect(() => {
    if (!dirty) return;
    function protectUnload(event: BeforeUnloadEvent) {
      if (busy.current) return;
      event.preventDefault();
      event.returnValue = '';
    }
    function protectNavigation(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
        || !(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLAnchorElement>('a[href]');
      if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
      const next = new URL(link.href);
      if (next.origin !== location.origin || (next.pathname === location.pathname && next.search === location.search)) return;
      if (!window.confirm('展示有未保存的修改。仍要离开吗？')) {
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

  function selectMaterial(selection: ShowcaseSelection) {
    const key = showcaseSelectionKey(selection);
    if (selectedKeys.has(key)) {
      setDraft({ ...draft, selections: draft.selections.filter(item => showcaseSelectionKey(item) !== key) });
    } else if (draft.selections.length < limits.materials) {
      setDraft({ ...draft, selections: [...draft.selections, selection] });
    }
  }

  function moveMaterial(index: number, offset: -1 | 1) {
    const selections = draft.selections.slice();
    const other = index + offset;
    [selections[index], selections[other]] = [selections[other], selections[index]];
    setDraft({ ...draft, selections });
  }

  function checkbox(source: ShowcaseSource, fileId: string | null, label: string) {
    const selection = { source: source.source, sourceId: source.id, fileId, caption: '' };
    const key = showcaseSelectionKey(selection);
    const checked = selectedKeys.has(key);
    const unavailable = unavailableKeys.has(key);
    return <label className={styles.choice}>
      <input type="checkbox" checked={checked} disabled={!checked && (unavailable || draft.selections.length >= limits.materials)}
        onChange={() => selectMaterial(selection)}/>
      <span>{label}{unavailable && '（已无法读取）'}</span>
    </label>;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || !canSave) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const result = await saveShowcaseDraftAction(offeringId, groupId, viewerId, latest?.revision ?? saved.revision, draft);
      if (result.conflict) {
        setConflict(result.conflict);
        setCheckedRevision(null);
        return;
      }
      if (result.unavailableSelections) {
        const missing = result.unavailableSelections;
        setUnavailableKeys(keys => new Set([...keys, ...missing]));
        return;
      }
      if (result.revision === undefined) {
        setError(result.error || '暂未确认保存结果。修改还在，可以重试。');
        return;
      }
      setSaved({ revision: result.revision, draft });
      setConflict(null);
      router.push(previewHref);
    } catch {
      setError('暂未确认保存结果。修改还在，可以重试。');
    } finally {
      setPending(false);
      busy.current = false;
    }
  }

  return <form method="post" className={styles.editor} aria-label="整理展示" onSubmit={submit}>
    <fieldset className={styles.fields} disabled={pending}>
      {latest && <>
        <section className={styles.comparison} aria-labelledby="showcase-conflict-heading">
          <h2 id="showcase-conflict-heading" ref={conflictHeading} tabIndex={-1}>展示草稿已有更新</h2>
          <p>你的修改仍在下方。请对照最新稿，把需要保留的内容合并到编辑区。</p>
          <h3>最新保存的第 {latest.revision} 版</h3>
          <dl className={styles.comparisonText}>
            <div><dt>项目标题</dt><dd>{latest.title || '未填写'}</dd></div>
            <div><dt>一句话介绍</dt><dd>{latest.summary || '未填写'}</dd></div>
            <div><dt>项目是怎么做出来的</dt><dd>{latest.body || '未填写'}</dd></div>
          </dl>
          <h3>最新稿的材料顺序</h3>
          {latest.selections.length ? <ol className={styles.comparisonMaterials}>{latest.selections.map(selection => {
            const { source, file, available } = selectionMaterial(sourceIndex, selection);
            const key = showcaseSelectionKey(selection);
            const name = file ? `${file.name} · ${source?.label}` : source?.label;
            const href = file?.href ?? source?.href;
            return <li key={key}>
              {available && !unavailableKeys.has(key) && href ? <a href={href} target="_blank" rel="noreferrer">{name}{selection.fileId === null && ' · 文字'} ↗</a>
                : <p>{name ? `${name}（原材料已无法读取）` : '原材料已无法读取'}</p>}
              {selection.caption && <p className={styles.comparisonCaption}>{selection.caption}</p>}
            </li>;
          })}</ol> : <p>尚未选材。</p>}
          <label className={styles.confirmComparison}>
            <input type="checkbox" checked={canSave} onChange={event => setCheckedRevision(event.target.checked ? latest.revision : null)}/>
            <span>我已核对最新稿，编辑区保留了需要的修改</span>
          </label>
        </section>
        <h2>我的修改</h2>
      </>}
      <div className="form-field">
        <label htmlFor="showcase-title">项目标题</label>
        <input id="showcase-title" name="title" value={draft.title} maxLength={limits.title}
          onChange={event => setDraft({ ...draft, title: event.target.value })}/>
      </div>
      <div className="form-field">
        <label htmlFor="showcase-summary">一句话介绍（选填）</label>
        <input id="showcase-summary" name="summary" value={draft.summary} maxLength={limits.summary}
          placeholder="这个项目想为谁解决什么问题？"
          onChange={event => setDraft({ ...draft, summary: event.target.value })}/>
      </div>
      <div className="form-field">
        <label htmlFor="showcase-body">项目是怎么做出来的</label>
        <textarea id="showcase-body" name="body" rows={9} value={draft.body} maxLength={limits.body}
          placeholder="从哪个问题出发？哪些发现改变了方案？做了什么原型，测试后得到了什么结果？"
          onChange={event => setDraft({ ...draft, body: event.target.value })}/>
      </div>
      <section className={styles.picker} aria-labelledby="materials-to-select">
        <h2 id="materials-to-select">从已有工作选材料</h2>
        {sourceKinds.map(({ kind, label, empty }) => {
          const items = pickerSources.filter(source => source.source === kind);
          return <details key={kind} className={styles.sourceKind} open={kind === 'ACTIVITY' ? true : undefined}>
            <summary>{label}</summary>
            {items.length === 0 && <p className="field-help">{empty}</p>}
            {items.map(source => <div className={styles.source} key={source.id}>
              <h3>{source.label}</h3>
              <a href={source.href} target="_blank" rel="noreferrer">查看原件 ↗</a>
              {source.body && <>
                <p className={styles.excerpt}>{source.body}</p>
                {checkbox(source, null, '选入这段文字')}
              </>}
              <ul className={styles.fileChoices}>{source.files.map(file => <li key={file.id}>
                {checkbox(source, file.id, file.name)}
                <a href={file.href} target="_blank" rel="noreferrer" aria-label={`打开 ${file.name}`}>打开 ↗</a>
              </li>)}</ul>
            </div>)}
          </details>;
        })}
        {draft.selections.length >= limits.materials && <p role="status" className="field-help">已选满 {limits.materials} 项。可以先移除一项再添加。</p>}
      </section>
      {draft.selections.length > 0 && <section className={styles.chosen} aria-labelledby="chosen-materials">
        <h2 id="chosen-materials">已选材料</h2>
        <p className="field-help">第一张图片用作代表图。可以调整阅读顺序，并说明材料怎样支持当时的决定。</p>
        <ol>{draft.selections.map((selection, index) => {
          const key = showcaseSelectionKey(selection);
          const current = selectionMaterial(sourceIndex, selection);
          const available = current.available && !unavailableKeys.has(key);
          const original = available ? current : selectionMaterial(originalSourceIndex, selection);
          const file = current.file ?? original.file;
          const source = current.source ?? original.source;
          const name = file?.name || source?.label || '这项来源已不可用';
          const sourceLabel = file ? source?.label : undefined;
          const labelledName = sourceLabel ? `${name} · ${sourceLabel}` : name;
          return <li key={key}>
            <div className={styles.selectionHeading}>
              <div className={styles.selectionIdentity}>
                <h3>{name}</h3>
                {sourceLabel && <p className={styles.meta}>{sourceLabel}</p>}
              </div>
              <div className={styles.selectionActions}>
                <button type="button" onClick={() => moveMaterial(index, -1)} disabled={index === 0} aria-label={`上移 ${labelledName}`}>上移</button>
                <button type="button" onClick={() => moveMaterial(index, 1)} disabled={index === draft.selections.length - 1} aria-label={`下移 ${labelledName}`}>下移</button>
                <button type="button" onClick={() => selectMaterial(selection)} aria-label={`移除 ${labelledName}`}>移除</button>
              </div>
            </div>
            {!available && <p className="field-help">这项原材料已无法读取。请移除后保存。</p>}
            {(available || selection.caption) && <label className="form-field">材料说明（选填）
              <textarea aria-label={`材料说明（选填） · ${labelledName}`} value={selection.caption} rows={2} maxLength={limits.caption} readOnly={!available}
                onChange={event => setDraft({
                  ...draft, selections: draft.selections.map((item, i) => i === index ? { ...item, caption: event.target.value } : item),
                })}/>
            </label>}
          </li>;
        })}</ol>
      </section>}
    </fieldset>
    {hasUnavailableSelections && <p className="notice error" role="alert">部分选材已无法读取。请移除或更换<a href="#chosen-materials">已标出的材料</a>后再保存。</p>}
    {error && <p className="notice error" role="alert">{error} <a href={editHref} target="_blank" rel="noreferrer">在新标签查看当前草稿</a></p>}
    <div className={styles.controls}>
      <button className="button primary" type="submit" disabled={pending || !canSave}>{pending ? '正在保存…' : '保存并预览'}</button>
      <p className="field-help">草稿供本组和本期教学团队查看。</p>
    </div>
  </form>;
}
