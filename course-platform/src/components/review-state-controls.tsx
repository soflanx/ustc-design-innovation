'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { setSubmissionReviewStateAction, type ReviewStateResult } from '@/lib/teaching-actions';
import styles from '@/app/teaching.module.css';

export function ReviewStateControls({ reviewerId, offeringId, versionId, state, revision }: {
  reviewerId: string; offeringId: string; versionId: string; state: 'PENDING' | 'COMPLETED' | 'LEGACY_UNKNOWN'; revision: number;
}) {
  const router = useRouter();
  const [result, submit, pending] = useActionState(async (previous: ReviewStateResult, form: FormData): Promise<ReviewStateResult> => {
    try { return await setSubmissionReviewStateAction(offeringId, versionId, previous, form); }
    catch { return { error: '暂未确认更新结果，请先核对此版本的评阅状态。' }; }
  }, {});
  // Reload an independently changed review state on a CAS rejection as well as
  // success. Completing a review may remove its version from the current filter.
  useEffect(() => { if (result.success || result.revisionConflict) router.refresh(); }, [result, router]);
  return <form action={submit} className={styles.reviewStateControls}>
    <input type="hidden" name="expectedUserId" value={reviewerId}/>
    <input type="hidden" name="expectedRevision" value={revision}/>
    <div className={styles.reviewStateActions}>
      {state !== 'COMPLETED' && <button type="submit" name="state" value="COMPLETED" className="button secondary" disabled={pending}>完成本轮评阅</button>}
      {state !== 'PENDING' && <button type="submit" name="state" value="PENDING" className="button secondary" disabled={pending}>{state === 'LEGACY_UNKNOWN' ? '标记为待评阅' : '重新打开评阅'}</button>}
      {pending && <span role="status">正在更新…</span>}
    </div>
    {state !== 'COMPLETED' && <p className={styles.countHelp}>写完评语后，可标记本轮评阅完成。</p>}
    {result.error && <p className="notice error" role="alert">{result.error}</p>}
    {result.success && <p className={styles.countHelp} role="status">{result.success}</p>}
  </form>;
}
