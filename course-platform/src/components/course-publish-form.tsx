'use client';

import Link from 'next/link';
import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { COURSE_PRESETS, presetOfferingTitle } from '@/lib/course-presets';
import { publishPresetCourseAction } from '@/lib/course-publication-actions';
import type { UstcTerm } from '@/lib/ustc-calendar';
import styles from './course-publish-form.module.css';

type PresetKey = 'thinking' | 'practice';
export type ExistingPresetOffering = { preset: PresetKey; termKey: string; id: string; status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED' };

export function CoursePublishForm({ terms, currentTermKey, publishable, existing, initialPreset }: {
  terms: UstcTerm[];
  currentTermKey: string;
  publishable: PresetKey[];
  existing: ExistingPresetOffering[];
  initialPreset?: PresetKey;
}) {
  const [termKey, setTermKey] = useState(currentTermKey);
  const [publishing, setPublishing] = useState<PresetKey>();
  const [state, action, pending] = useActionState(publishPresetCourseAction, {});
  const router = useRouter();
  const term = terms.find(item => item.key === termKey);
  const ordered = initialPreset ? [...COURSE_PRESETS].sort((a, b) => Number(b.key === initialPreset) - Number(a.key === initialPreset)) : COURSE_PRESETS;
  useEffect(() => { if (state.redirectTo) router.push(state.redirectTo); }, [state.redirectTo, router]);

  return <form action={action} className={styles.form}>
    <div className={styles.termRow}>
      <div className={styles.termField}>
        <label htmlFor="publish-term">学期</label>
        <select id="publish-term" name="termKey" value={termKey} disabled={pending || !!state.redirectTo} onChange={event => setTermKey(event.target.value)}>
          {!terms.some(item => item.key === currentTermKey) && <option value={currentTermKey} disabled>当前学期 · 校历待同步</option>}
          {terms.map(item => <option key={item.key} value={item.key}>{item.name}{item.key === currentTermKey ? '（本学期）' : ''}</option>)}
        </select>
      </div>
      {term && <p className={styles.calendar}><span>{term.startsOn.replaceAll('-', '/')} — {term.endsOn.replaceAll('-', '/')}</span>
        <a href={term.sourceUrl} target="_blank" rel="noreferrer">中国科大教务处校历 ↗</a>
      </p>}
    </div>
    {!term && <p className="notice" role="status">本学期校历尚未同步，暂时无法发布。请稍后重试。</p>}
    <div className={styles.courses}>
      {ordered.map(preset => {
        const published = existing.find(item => item.preset === preset.key && item.termKey === termKey);
        const allowed = publishable.includes(preset.key);
        const title = term ? presetOfferingTitle(preset.key, term.season) : preset.title;
        return <article className={styles.course} key={preset.key}>
          <div>
            <h2>{title}</h2>
            <p>{preset.key === 'thinking' ? '春季、秋季均开设' : term ? term.season === 'autumn' ? '秋季 · 实践Ⅰ' : '春季 · 实践Ⅱ' : '秋季Ⅰ · 春季Ⅱ'}</p>
          </div>
          {allowed && published ? <Link className="button secondary" href={published.status === 'DRAFT' ? `/courses/${published.id}/manage` : `/courses/${published.id}`}>
            {published.status === 'ACTIVE' ? '进入课程' : published.status === 'DRAFT' ? '继续筹备' : '查看归档'}
          </Link> : allowed ? <button className="button primary" type="submit" name="preset" value={preset.key} aria-label={`发布${title}`} disabled={!term || pending || !!state.redirectTo} onClick={() => setPublishing(preset.key)}>
            {pending && publishing === preset.key ? '正在发布…' : '发布课程'}
          </button> : <p className={styles.permission}>请联系课程负责人发布</p>}
        </article>;
      })}
    </div>
    {state.error && <p className="notice error" role="alert">{state.error}</p>}
    <p className={styles.note}>课程负责人自动加入本期教学团队。助教和学生可在课程内添加。</p>
  </form>;
}
