'use client';

import { useActionState, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { MAX_FORMAL_SUBMISSION_FILE_BYTES, MAX_SUBMISSION_FILES, MAX_SUBMISSION_FILE_BYTES, type SubmissionContext, type SubmissionFormState } from '@/lib/submission-contract';
import { stageSubmissionFiles, SubmissionChunkError, SubmissionUploadReleases, uploadReleaseFailed, type ChosenSubmissionFile, type SubmissionUploadProgress } from '@/lib/submission-chunk-client';
import { confirmSubmissionDraft, draftAfterRejectedSubmission, editSubmissionDraft, newSubmissionDraft, restoreSubmissionDraft, revisionDraftAction, submissionReviewReasons, writeStoredSubmissionDraft, type SubmissionDraft } from '@/lib/submission-draft';
import { formatTeachingDate } from '@/lib/teaching-format';
import teachingStyles from '@/app/teaching.module.css';
import styles from './submission-form.module.css';
import { LinkedTextParts, SubmissionText } from './submission-text';

type Props = {
  action: (state: SubmissionFormState, form: FormData) => Promise<SubmissionFormState>;
  draftKey: string;
  assignmentHref: string;
  expectedUserId: string;
  requestId: string;
  context: SubmissionContext;
  hasCurrentSubmission: boolean;
  revisionSource?: { versionId: string; feedback: { id: string; author: string; body: string }[] };
};

function chosenUploads(files: ChosenSubmissionFile[], progress: SubmissionUploadProgress) {
  return files.flatMap(choice => {
    const upload = progress.get(choice);
    return upload ? [upload] : [];
  });
}

// A changed account/task remounts the editor before any previous draft can appear.
export function SubmissionForm(props: Props) {
  return <DraftEditor key={props.draftKey} {...props}/>;
}

function DraftEditor({ action, draftKey, assignmentHref, expectedUserId, requestId, context, hasCurrentSubmission, revisionSource }: Props) {
  const router = useRouter();
  const fieldId = useId();
  const storageKey = `design-course:submission:${draftKey}`;
  const [draft, setDraft] = useState(() => newSubmissionDraft(requestId, context));
  const [visibleContext, setVisibleContext] = useState(context);
  const [acknowledged, setAcknowledged] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [storageStatus, setStorageStatus] = useState('正在读取本浏览器草稿…');
  const [storageFailed, setStorageFailed] = useState(false);
  const [revisionHost, setRevisionHost] = useState<HTMLElement | null>(null);
  const [openRevision, setOpenRevision] = useState(0);
  const [files, setFiles] = useState<ChosenSubmissionFile[]>([]);
  const [fileError, setFileError] = useState('');
  const [uploadProgress, setUploadProgress] = useState<{ received: number; total: number } | null>(null);
  const [releaseError, setReleaseError] = useState('');
  const [releasingDraftUploads, setReleasingDraftUploads] = useState(false);
  const [uploadReleases] = useState(() => new SubmissionUploadReleases(assignmentHref, expectedUserId));
  const fileUploads = useRef<SubmissionUploadProgress>(new WeakMap());
  const restoredDraft = useRef(false);
  const current = useRef(draft);
  const currentContext = useRef(context);
  const previousPageContext = useRef(context);
  const canPersist = useRef(false);
  const storageSnapshot = useRef<string | null>(null);
  const sending = useRef(false);
  const ownReceipt = useRef<string | null>(null);
  const submittedFrom = useRef<string | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const editor = useRef<HTMLDetailsElement>(null);
  const bodyField = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const processed = useRef<SubmissionFormState | null>(null);
  const sourceId = revisionSource?.versionId;

  const flushUploadReleases = useCallback(async () => {
    try {
      await uploadReleases.flush();
      setReleaseError('');
      return null;
    } catch (error) {
      const failure = error instanceof SubmissionChunkError ? error : new SubmissionChunkError(uploadReleaseFailed, false);
      setReleaseError(failure.message);
      return failure;
    }
  }, [uploadReleases]);

  useEffect(() => {
    const retry = () => { void flushUploadReleases(); };
    retry();
    window.addEventListener('online', retry);
    window.addEventListener('focus', retry);
    return () => {
      window.removeEventListener('online', retry);
      window.removeEventListener('focus', retry);
    };
  }, [flushUploadReleases]);

  useEffect(() => {
    setRevisionHost(sourceId ? document.getElementById(`revise-from-${sourceId}`) : null);
  }, [sourceId, requestId]);

  useLayoutEffect(() => {
    if (!openRevision || !editor.current) return;
    editor.current.open = true;
    const target = reviewHeading.current ?? bodyField.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'center' });
  }, [openRevision]);

  function updateDraft(next: SubmissionDraft) {
    current.current = next;
    setDraft(next);
  }

  const persist = useCallback((value: SubmissionDraft, basedOnVersion?: number) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    if (!canPersist.current) return;
    try {
      const saved = writeStoredSubmissionDraft(localStorage, storageKey, storageSnapshot.current, value);
      if (saved === undefined) {
        setStorageFailed(true);
        setStorageStatus('另一标签页已更改本浏览器中的草稿。本页输入尚未保存，可先复制正文。');
        return;
      }
      storageSnapshot.current = saved;
      setStorageFailed(false);
      setStorageStatus(basedOnVersion ? `已用第 ${basedOnVersion} 版原文起草，已保存在本浏览器，尚未提交。`
        : value.pendingAttempt ? '提交结果尚待确认，正文已保存在本浏览器。' : value.body ? '草稿已保存在本浏览器，尚未提交。' : '正文会自动保存在本浏览器，尚未提交。');
      return saved;
    } catch {
      setStorageFailed(true);
      setStorageStatus('未能保存本地草稿。输入仍在当前页面，请勿刷新或关闭，可先复制正文。');
    }
  }, [storageKey]);

  const flushDraft = useCallback(() => {
    if (saveTimer.current !== undefined) persist(current.current);
  }, [persist]);

  function queueUploadReleases(ids: string[]) {
    if (!ids.length) return false;
    let saved: string | null;
    try { saved = localStorage.getItem(storageKey); }
    catch { saved = null; }
    if (saved !== null && saved !== storageSnapshot.current) {
      try {
        const other = restoreSubmissionDraft(saved, requestId);
        const inUse = new Set(other.stagedFileIds ?? other.uploadingFileIds);
        ids = ids.filter(id => !inUse.has(id));
      } catch { return false; }
    }
    uploadReleases.add(ids);
    return ids.length > 0;
  }

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      storageSnapshot.current = saved;
      if (saved) {
        const restored = restoreSubmissionDraft(saved, requestId);
        updateDraft(restored);
        restoredDraft.current = true;
        setStorageStatus(restored.pendingAttempt ? '已恢复上次待确认的提交，正文保留在本浏览器。' : '已恢复本浏览器中的草稿，尚未提交。');
      } else setStorageStatus('正文会自动保存在本浏览器，尚未提交。');
      canPersist.current = true;
    } catch {
      setStorageFailed(true);
      setStorageStatus('无法读取本地草稿。当前输入仍可提交，但请自行保留副本。');
    }
    setReady(true);
    // Restoration never substitutes freshly rendered confirmation values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (previousPageContext.current === context) return;
    previousPageContext.current = context;
    currentContext.current = context;
    setVisibleContext(context);
    // Success ended the previous draft. Adopt only its own result in an empty
    // editor; an existing draft always keeps its original checked context.
    if (ownReceipt.current && !current.current.body && context.latestSubmission?.id === ownReceipt.current
      && current.current.confirmation?.assignmentRevision === context.confirmation.assignmentRevision
      && current.current.confirmation?.groupId === context.confirmation.groupId) {
      updateDraft(confirmSubmissionDraft(current.current, context));
      ownReceipt.current = null;
    }
  }, [context]);

  useEffect(() => {
    if (!ready) return;
    function onVisibility() { if (document.visibilityState === 'hidden') flushDraft(); }
    window.addEventListener('pagehide', flushDraft);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flushDraft);
      document.removeEventListener('visibilitychange', onVisibility);
      // Also flush when Next navigates without a full page unload.
      flushDraft();
    };
  }, [ready, flushDraft]);

  const [state, formAction, pending] = useActionState(async (previous: SubmissionFormState, form: FormData): Promise<SubmissionFormState> => {
    flushDraft();
    const value = current.current;
    const submission = currentContext.current;
    // Retry the original operation first: the server returns a matching saved
    // version before checking later requirements, group changes, or deadlines.
    if (!value.pendingAttempt && submissionReviewReasons(value, submission).length) {
      sending.current = false;
      return { error: '请先核对当前要求与提交归属；正文已保留。' };
    }
    if (!value.pendingAttempt && !submission.canSubmit) {
      sending.current = false;
      return { error: submission.blockedReason || '当前不可提交，正文已保留。' };
    }
    // Send the form snapshot captured by this click, not newer mutable state.
    const retainedFileIds = value.retainedFileIds ?? submission.latestSubmission?.attachments?.map(file => file.id) ?? [];
    if (!value.stagedFileIds?.length && value.uploadNames?.length && files.length !== value.uploadNames.length) {
      sending.current = false;
      return { error: '请重新选择草稿中的附件，再继续提交。' };
    }
    if (!value.body.trim() && !files.length && !retainedFileIds.length && !value.stagedFileIds?.length) {
      sending.current = false;
      return { error: '请填写说明或添加至少一个附件。' };
    }
    const uploadSize = files.reduce((total, { file }) => total + file.size, 0);
    const keptSize = submission.latestSubmission?.attachments
      ?.filter(file => retainedFileIds.includes(file.id)).reduce((total, file) => total + file.size, 0) ?? 0;
    if (!value.pendingAttempt && uploadSize + keptSize > MAX_FORMAL_SUBMISSION_FILE_BYTES) {
      sending.current = false;
      return { error: '保留和新增附件合计不能超过 200 MiB。请移除部分附件后再提交。' };
    }
    try {
      let stagedFileIds = value.stagedFileIds;
      const uploads = chosenUploads(files, fileUploads.current);
      if (!stagedFileIds && (uploadSize > MAX_SUBMISSION_FILE_BYTES || uploads.length)) {
        queueUploadReleases(uploads.filter(upload => upload.unavailable).map(upload => upload.id));
        const releaseFailure = await flushUploadReleases();
        if (releaseFailure?.identityBlocked) return { identityBlocked: true };
        for (const choice of files) {
          if (fileUploads.current.get(choice)?.unavailable) fileUploads.current.delete(choice);
        }
        try {
          stagedFileIds = await stageSubmissionFiles(assignmentHref, expectedUserId, files, fileUploads.current,
            received => setUploadProgress({ received, total: uploadSize }), () => {
              const ids = chosenUploads(files, fileUploads.current).map(upload => upload.id);
              const uploading = { ...current.current, uploadingFileIds: ids.length ? ids : undefined };
              updateDraft(uploading);
              persist(uploading);
            });
        } catch (error) {
          if (error instanceof SubmissionChunkError) {
            return { error: error.message, ...(error.identityBlocked ? { identityBlocked: true } : {}) };
          }
          return { error: '附件上传中断，正文和所选文件已保留。重新提交可从已上传的位置继续。' };
        } finally {
          setUploadProgress(null);
        }
      }
      if (stagedFileIds) {
        for (const id of stagedFileIds) form.append('stagedFileIds', id);
      } else {
        for (const { file } of files) form.append('attachments', file);
      }
      for (const id of retainedFileIds) form.append('retainedFileIds', id);
      const retainedFromVersionId = value.pendingAttempt ? value.retainedFromVersionId : submission.latestSubmission?.id;
      const attempt = { ...value, retainedFileIds, retainedFromVersionId, stagedFileIds, uploadingFileIds: undefined, pendingAttempt: true };
      updateDraft(attempt);
      const attemptSnapshot = persist(attempt);
      const result = await action(previous, form);
      if (result.success) {
        ownReceipt.current = result.receipt?.id ?? null;
        submittedFrom.current = submission.latestSubmission?.id ?? null;
        updateDraft(newSubmissionDraft(crypto.randomUUID(), currentContext.current));
        setAcknowledged(null);
        fileUploads.current = new WeakMap();
        setFiles([]); setFileError(''); restoredDraft.current = false;
        try {
          const cleared = typeof attemptSnapshot === 'string'
            && writeStoredSubmissionDraft(localStorage, storageKey, attemptSnapshot, null) !== undefined;
          if (cleared) storageSnapshot.current = null;
          setStorageFailed(false);
          setStorageStatus(cleared ? '提交已成功，本浏览器草稿已清除。' : '提交已成功。');
        } catch {
          setStorageFailed(true);
          setStorageStatus('提交已成功，但未能清除本浏览器草稿。再次打开时请核对提交记录，避免重复提交。');
        }
      } else if (result.resetUpload) {
        for (const upload of chosenUploads(files, fileUploads.current)) upload.unavailable = true;
        const retry = { ...attempt, stagedFileIds: undefined, uploadingFileIds: stagedFileIds, pendingAttempt: false };
        updateDraft(retry);
        persist(retry);
      } else if (result.identityBlocked || result.conflict || result.blocked) {
        const retained = result.blocked ? { ...attempt, pendingAttempt: false }
          : draftAfterRejectedSubmission({ ...attempt, pendingAttempt: value.pendingAttempt }, result.identityBlocked ? 'identityBlocked' : 'conflict');
        updateDraft(retained);
        persist(retained);
        const freshContext = result.blocked ?? result.conflict?.context;
        if (freshContext) {
          currentContext.current = freshContext;
          setVisibleContext(freshContext);
          setAcknowledged(null);
        }
      }
      return result;
    } catch {
      return { error: '暂未确认提交结果，正文已保留。请先重试或查看提交记录。' };
    } finally {
      sending.current = false;
    }
  }, {});

  useEffect(() => {
    if (state.success && processed.current !== state) {
      processed.current = state;
      if (editor.current) editor.current.open = false;
      router.refresh();
    }
  }, [state, router]);
  useEffect(() => { if (state.conflict) reviewHeading.current?.focus(); }, [state.conflict]);

  const reasons = submissionReviewReasons(draft, visibleContext);
  const needsReview = ready && reasons.length > 0;
  const requirements = visibleContext.requirements;
  const latest = visibleContext.latestSubmission;
  const existingFiles = latest?.attachments ?? [];
  const retainedFileIds = draft.retainedFileIds ?? existingFiles.map(file => file.id);
  const needsFilesAgain = !!draft.uploadNames?.length && !files.length && !draft.stagedFileIds?.length;
  const hasRestoredUploads = !!draft.stagedFileIds?.length && !files.length;
  const hasStagedUploads = !!(draft.stagedFileIds?.length || draft.uploadingFileIds?.length);
  const groupName = visibleContext.groupName;
  const hasGroupChange = reasons.includes('group') || (reasons.includes('unconfirmed') && draft.expectedGroupId !== visibleContext.confirmation.groupId);
  const blocked = !visibleContext.canSubmit;

  useEffect(() => {
    if (!ready || !hasCurrentSubmission || !context.canSubmit || blocked || state.identityBlocked) return;
    function openLinkedEditor() {
      if (window.location.hash === '#submission' && editor.current) editor.current.open = true;
    }
    openLinkedEditor();
    window.addEventListener('hashchange', openLinkedEditor);
    return () => window.removeEventListener('hashchange', openLinkedEditor);
  }, [ready, hasCurrentSubmission, context.canSubmit, blocked, state.identityBlocked]);

  const source = revisionSource && previousPageContext.current === context && context.canSubmit && !state.identityBlocked && sourceId !== submittedFrom.current
    && context.latestSubmission?.id === sourceId && latest?.id === sourceId && !blocked ? revisionSource : undefined;
  const revisionAction = source && ready ? revisionDraftAction(draft, visibleContext, source.versionId, !storageFailed && canPersist.current) : null;

  function startRevision() {
    if (!source || !ready || sending.current || pending || !revisionHost?.isConnected) return;
    const live = currentContext.current;
    const value = current.current;
    const next = revisionDraftAction(value, live, source.versionId, !storageFailed && canPersist.current);
    if (!next || !live.latestSubmission) return;
    if (next === 'seed') {
      flushDraft();
      // Another tab may have saved a draft since this feedback page was opened.
      try {
        const saved = localStorage.getItem(storageKey);
        storageSnapshot.current = saved;
        if (saved !== null) {
          const restored = restoreSubmissionDraft(saved, requestId);
          updateDraft(restored);
          restoredDraft.current = true;
          setStorageStatus(restored.pendingAttempt ? '已恢复上次待确认的提交，正文保留在本浏览器。' : '已恢复本浏览器中的草稿，尚未提交。');
        } else {
          const seeded = editSubmissionDraft(value, live.latestSubmission.body, crypto.randomUUID());
          updateDraft(seeded);
          persist(seeded, live.latestSubmission.version);
        }
      } catch {
        canPersist.current = false;
        setStorageFailed(true);
        setStorageStatus('无法读取本地草稿。当前输入仍可提交，但请自行保留副本。');
      }
    }
    setOpenRevision(count => count + 1);
  }

  function changeFiles(next: ChosenSubmissionFile[]) {
    if (sending.current) return;
    const value = current.current;
    const releasingReadOnly = blocked && !next.length;
    if (releasingReadOnly && (value.pendingAttempt || state.identityBlocked || releasingDraftUploads)) return;
    const size = next.reduce((total, { file }) => total + file.size, 0)
      + existingFiles.filter(file => retainedFileIds.includes(file.id)).reduce((total, file) => total + file.size, 0);
    if (next.length + retainedFileIds.length > MAX_SUBMISSION_FILES || size > MAX_FORMAL_SUBMISSION_FILE_BYTES || next.some(({ file }) => !file.size || file.name.length > 255)) {
      setFileError('附件最多 20 个，合计不能超过 200 MiB。请选择非空文件，文件名不能超过 255 个字符。');
      return;
    }
    const names = next.map(({ file }) => file.name);
    const restoring = needsFilesAgain || hasRestoredUploads;
    const restoringOriginalFiles = needsFilesAgain && value.pendingAttempt && JSON.stringify(names) === JSON.stringify(value.uploadNames);
    if (restoring && value.pendingAttempt && !restoringOriginalFiles && next.length) {
      setFileError('请按原顺序重新选择同名文件以核对上次提交，或先清除选件再开始新的更正。');
      return;
    }
    const nextIds = chosenUploads(next, fileUploads.current).map(upload => upload.id);
    const removed = restoringOriginalFiles ? [] : (value.stagedFileIds ?? value.uploadingFileIds ?? []).filter(id => !nextIds.includes(id));
    const allStaged = next.length && next.every(choice => {
      const upload = fileUploads.current.get(choice);
      return upload && !upload.unavailable && upload.receivedBytes === choice.file.size;
    });
    const continuingIds = restoringOriginalFiles ? value.uploadingFileIds : nextIds;
    const edited = { ...value, uploadNames: names, stagedFileIds: allStaged ? nextIds : undefined,
      uploadingFileIds: !allStaged && continuingIds?.length ? continuingIds : undefined,
      ...(!restoringOriginalFiles && !releasingReadOnly ? { requestId: crypto.randomUUID(), pendingAttempt: false } : {}) };
    function applySelection() {
      setFiles(next); setFileError('');
      updateDraft(edited); persist(edited);
    }
    if (releasingReadOnly) {
      if (!queueUploadReleases(removed)) {
        setFileError('本浏览器中的草稿已变更，请重新打开作业后再释放附件。');
        return;
      }
      setReleasingDraftUploads(true);
      void flushUploadReleases().then(failure => {
        setReleasingDraftUploads(false);
        if (!failure?.identityBlocked && current.current === value) applySelection();
      });
      return;
    }
    applySelection();
    if (queueUploadReleases(removed)) void flushUploadReleases();
  }

  function setRetained(next: string[]) {
    if (sending.current) return;
    const value = current.current;
    const edited = { ...value, retainedFileIds: next, retainedFromVersionId: latest?.id, requestId: crypto.randomUUID(), pendingAttempt: false };
    updateDraft(edited); persist(edited);
  }

  function seedCorrection() {
    if (!ready || sending.current || !context.canSubmit || blocked || state.identityBlocked || !latest || restoredDraft.current
      || draft.body || draft.pendingAttempt || needsReview || draft.retainedFileIds || draft.uploadNames?.length) return;
    restoredDraft.current = true;
    const seeded = editSubmissionDraft(draft, latest.body, crypto.randomUUID());
    if (seeded === draft) return;
    updateDraft(seeded);
    persist(seeded, latest.version);
  }

  const form = <form action={formAction} className={styles.form} aria-busy={pending} onSubmit={event => {
    // Prevent a second queued UI action before React commits its pending state.
    if (sending.current) event.preventDefault();
    else sending.current = true;
  }}>
    <input type="hidden" name="requestId" value={draft.requestId}/>
    <input type="hidden" name="expectedAssignmentRevision" value={draft.confirmation?.assignmentRevision ?? ''}/>
    <input type="hidden" name="expectedLatestSubmissionToken" value={draft.confirmation?.latestSubmissionToken ?? ''}/>
    <input type="hidden" name="expectedGroupId" value={draft.confirmation ? draft.confirmation.groupId || '' : draft.expectedGroupId || ''}/>
    {needsReview && <section className={styles.reviewPanel} aria-labelledby={`${fieldId}-review-heading`}>
      <h3 id={`${fieldId}-review-heading`} ref={reviewHeading} tabIndex={-1}>提交前，请核对变化</h3>
      <p className={styles.reviewIntro}>{reasons.includes('unconfirmed') ? '这份草稿没有保存当时的确认信息，请核对下面的当前要求与提交归属。' : '草稿正文已保留，尚未按下面的新信息提交。'}</p>
      <ul className={styles.changeList}>
        {reasons.includes('requirements') && <li>草稿对应要求第 {draft.confirmation?.assignmentRevision} 版，当前为第 {requirements.revision} 版。</li>}
        {hasGroupChange && <li>提交归属已变化：{requirements.mode === 'GROUP' ? groupName ? `本次将代表${groupName}提交。` : '目前尚未分组。' : '当前为个人提交。'}</li>}
        {reasons.includes('latest_submission') && !hasGroupChange && <li>当前归属的提交状态已更新，请先核对已有记录。</li>}
      </ul>
      <div className={styles.currentRequirements}>
        <h4>当前要求 · 第 {requirements.revision} 版</h4>
        <strong>{requirements.title}</strong>
        <p className={styles.requirementFacts}>{requirements.mode === 'GROUP' ? '小组作业' : '个人作业'}<br/>{requirements.dueAt ? `截止 ${formatTeachingDate(requirements.dueAt)}` : '不设截止时间'}</p>
        <div className={styles.requirementBody}>{requirements.descriptionParts
          ? <LinkedTextParts parts={requirements.descriptionParts}/> : requirements.description || '当前未填写作业要求。'}</div>
        {requirements.cancellationReason && <p>取消原因：{requirements.cancellationReason}</p>}
      </div>
      {(reasons.includes('latest_submission') || reasons.includes('unconfirmed') || hasGroupChange) && <div className={styles.latestSubmission}>
        {latest ? <>
          <h4>当前正式成果</h4>
          <p>{latest.submittedByName} · {formatTeachingDate(latest.submittedAt)}</p>
          {latest.body.trim()
            ? <details><summary>查看已提交的说明</summary><div className={styles.requirementBody}><SubmissionText text={latest.body}/></div></details>
            : <p>未附文字说明。</p>}
          {!!latest.attachments?.length && <ul aria-label="当前正式成果附件">
            {latest.attachments.map(file => <li key={file.id}><a
              href={`${assignmentHref}/submissions/${encodeURIComponent(latest.id)}/files/${encodeURIComponent(file.id)}`}
              target="_blank" rel="noopener noreferrer">{file.name}</a></li>)}
          </ul>}
        </>
          : <p>这里只展示你有权读取的提交。请核对{requirements.mode === 'GROUP' ? '当前小组' : '个人'}归属，既有成果仍可从历史查看。</p>}
      </div>}
      {blocked ? <p className={styles.blockedReason} role="status">{visibleContext.blockedReason || '当前不可提交。'}正文仍保留在本浏览器。</p>
        : <button type="button" className="button secondary" disabled={pending || draft.pendingAttempt} onClick={() => {
          if (sending.current) return;
          const confirmed = confirmSubmissionDraft(current.current, visibleContext);
          updateDraft(confirmed);
          persist(confirmed);
          setAcknowledged(JSON.stringify(confirmed.confirmation));
        }}>已核对，保留正文继续</button>}
    </section>}
    {visibleContext.correctionUntil && !blocked && <p className="field-help">教学团队已为此成果开放更正至 {formatTeachingDate(visibleContext.correctionUntil)}。</p>}
    {ready && blocked && !needsReview && <p className={styles.blockedReason} role="status">{visibleContext.blockedReason || '当前不可提交。'}正文已保留，可以查看或复制。</p>}
    {ready && !needsReview && acknowledged === JSON.stringify(draft.confirmation) && <p className={styles.confirmedStatus} role="status">已核对当前要求第 {draft.confirmation?.assignmentRevision} 版{groupName ? `，本次代表${groupName}` : ''}。正文尚未提交。</p>}
    {draft.pendingAttempt && !pending && <p className={styles.retryNotice}>上次提交未完成或结果尚未确认。请先重试；如果已经保存，会返回原回执。{!blocked && '修改正文将开始一次新的提交。'}</p>}
    {source && source.feedback.length > 0 && latest && !needsReview && <details key={source.versionId} className={styles.revisionFeedback}>
      <summary>对照第 {latest.version} 版的反馈（{source.feedback.length}）</summary>
      {source.feedback.map(note => <div key={note.id}><strong>{note.author}</strong><p><SubmissionText text={note.body}/></p></div>)}
    </details>}
    <div className="form-field"><label htmlFor={fieldId}>提交说明（选填）</label><textarea ref={bodyField} id={fieldId} name="body" value={draft.body} onChange={event => {
      const next = event.target.value;
      if (sending.current || next === current.current.body) return;
      canPersist.current = true;
      updateDraft(editSubmissionDraft(current.current, next, crypto.randomUUID()));
      ownReceipt.current = null;
      clearTimeout(saveTimer.current);
      setStorageStatus('正在保存本浏览器草稿…');
      saveTimer.current = setTimeout(() => persist(current.current), 500);
    }} rows={12} maxLength={12000} readOnly={pending || !ready || blocked} aria-describedby={`${fieldId}-draft ${fieldId}-count`}/>
    <div className={styles.editorMeta}><p id={`${fieldId}-draft`} className={storageFailed ? styles.warning : styles.draftStatus} role="status">{storageStatus}</p><span id={`${fieldId}-count`}>{draft.body.length} / 12000</span></div>
    {groupName && <p className="field-help">{draft.pendingAttempt ? '重试会先核对上次提交结果，不会更改已经保存的提交归属。' : needsReview ? '请先核对上方的提交归属，再继续提交。' : `本次提交代表${groupName}，提交时的组员将保存在记录中。`}</p>}
    <div className="form-field">
      <label htmlFor={`${fieldId}-files`}>成果附件</label>
      {existingFiles.map(file => {
        const retained = retainedFileIds.includes(file.id);
        return <label key={file.id}>
          <input type="checkbox" checked={retained} disabled={pending || !ready || blocked || needsReview}
            ref={input => {
              // A resolved form action may reset native inputs even when the submission was rejected.
              if (input) input.defaultChecked = retained;
            }}
            onChange={event => setRetained(event.target.checked ? [...retainedFileIds, file.id] : retainedFileIds.filter(id => id !== file.id))}/>
          保留 {file.name}
        </label>;
      })}
      <input id={`${fieldId}-files`} type="file" multiple disabled={pending || !ready || (blocked && !draft.pendingAttempt) || (hasRestoredUploads && draft.pendingAttempt)} onChange={event => {
        const next = Array.from(event.target.files ?? [], file => ({ file }));
        if (next.length) changeFiles(needsFilesAgain || hasRestoredUploads ? next : [...files, ...next]);
        event.target.value = '';
      }}/>
      {files.length > 0 && <ul>{files.map(({ file }, index) => <li key={`${index}-${file.name}`}>{file.name}
        {!blocked && <> · <button type="button" className="link-button" disabled={pending} onClick={() => changeFiles(files.filter((_, item) => item !== index))}>移除</button></>}
      </li>)}</ul>}
      {hasRestoredUploads && <p className="field-help">已上传 {draft.uploadNames?.join('、')}。{draft.pendingAttempt && '请直接重试本次提交。'}
        {!blocked && <> <button type="button" className="link-button" disabled={pending} onClick={() => changeFiles([])}>{draft.pendingAttempt ? '清除选件，开始新提交' : '清除选件'}</button></>}
      </p>}
      {needsFilesAgain && <p className="field-help">{blocked && !draft.pendingAttempt ? `上次选取的附件：${draft.uploadNames?.join('、')}。`
        : `请重新选择 ${draft.uploadNames?.join('、')} 后继续。`}
        {!blocked && <> <button type="button" className="link-button" disabled={pending} onClick={() => changeFiles([])}>清除选件</button></>}
      </p>}
      {blocked && hasStagedUploads && !draft.pendingAttempt && <p><button type="button" className="button secondary"
        disabled={pending || state.identityBlocked || releasingDraftUploads} onClick={() => changeFiles([])}>
        {releasingDraftUploads ? '正在释放附件…' : '释放未提交附件'}
      </button></p>}
      {fileError && <p className="notice error" role="alert">{fileError}</p>}
      {releaseError && <p className="field-help" role="status">{releaseError}{' '}
        <button type="button" className="link-button" disabled={pending} onClick={() => { void flushUploadReleases(); }}>重试清理</button></p>}
      <p className="field-help">至少填写说明或添加一个附件。保留和新增附件最多 20 个，合计不超过 200 MiB。</p>
      {uploadProgress && <p className="field-help">正在上传附件 · {Math.floor(uploadProgress.received / uploadProgress.total * 100)}%{' '}
        <progress aria-label="附件上传进度" value={uploadProgress.received} max={uploadProgress.total}/></p>}
    </div>
    {latest && <p className="field-help">更正后会更新当前正式成果，原有成果与反馈仍可从更正历史查看。</p>}</div>
    {state.error && !state.conflict && !state.blocked && <div><p className="notice error" role="alert">{state.error}</p>
      {!state.identityBlocked && <p className="field-help">正文已保留。若刚才网络中断，请先重试或查看提交记录。</p>}
    </div>}
    {(!blocked || draft.pendingAttempt) && <div><button type="submit" className="button primary" disabled={pending || !ready || needsFilesAgain || (!draft.pendingAttempt && needsReview)}>{uploadProgress ? '正在上传…' : pending ? '正在提交…' : draft.pendingAttempt ? '重试本次提交' : latest ? '确认更正' : '确认提交'}</button></div>}
  </form>;

  return <>
    {revisionAction && source && latest && revisionHost?.id === `revise-from-${source.versionId}` && createPortal(
      <button type="button" className={`button secondary ${styles.reviseButton}`} onClick={startRevision} disabled={pending}>
        {revisionAction === 'seed' ? '更正这份成果' : revisionAction === 'continue' ? '继续本地草稿' : '打开草稿编辑器'}
      </button>, revisionHost)}
    {state.success && <div className={styles.receipt} role="status">
      <p>{state.success}</p>
      {state.receipt && <p>
        {formatTeachingDate(state.receipt.submittedAt)}{state.receipt.assignmentRevision !== null && ` · 要求第 ${state.receipt.assignmentRevision} 版`}<br/>
        <a href={`#version-${encodeURIComponent(state.receipt.id)}`}>查看本次正式成果 →</a>
      </p>}
    </div>}
    <details ref={editor} className={teachingStyles.submissionEditor} open={context.requirements.status !== 'CANCELLED' && !hasCurrentSubmission &&
      (context.requirements.mode !== 'GROUP' || context.confirmation.groupId !== null || Boolean(draft.pendingAttempt))}
      onToggle={event => { if (event.currentTarget.open && hasCurrentSubmission) seedCorrection(); }}>
      <summary>{blocked ? '查看本浏览器草稿' : hasCurrentSubmission ? '更正正式成果' : '提交作业'}</summary>
      <div className={teachingStyles.editorContent}>{form}</div>
    </details>
  </>;
}


/** Read-only recovery never mutates the draft, its request token, or its group context. */
export function ReadOnlySubmissionDraft({ draftKey, reason }: { draftKey: string; reason: string }) {
  return <SavedDraftReader key={draftKey} draftKey={draftKey} reason={reason}/>;
}

function SavedDraftReader({ draftKey, reason }: { draftKey: string; reason: string }) {
  const fieldId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<'loading' | 'found' | 'empty' | 'error'>('loading');
  const [copyStatus, setCopyStatus] = useState('');
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`design-course:submission:${draftKey}`);
      if (!saved) { setStatus('empty'); return; }
      const draft: unknown = JSON.parse(saved);
      if (!draft || typeof draft !== 'object' || !('body' in draft) || typeof draft.body !== 'string' || draft.body.length > 12000) throw new Error('INVALID_DRAFT');
      setBody(draft.body);
      setStatus(draft.body ? 'found' : 'empty');
    } catch { setStatus('error'); }
  }, [draftKey]);
  async function copyDraft() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE');
      await navigator.clipboard.writeText(body);
      setCopyStatus('草稿正文已复制。');
    } catch {
      textarea.current?.focus();
      textarea.current?.select();
      setCopyStatus('自动复制失败，已选中正文，请使用系统复制命令或长按复制。');
    }
  }
  return <div className={styles.savedDraft}>
    <p className={styles.readOnlyReason}>{reason}</p>
    <h3>本浏览器未提交草稿</h3>
    {status === 'loading' && <p role="status">正在读取草稿…</p>}
    {status === 'empty' && <p className="field-help">本浏览器没有此账号在这份作业中保存的草稿。</p>}
    {status === 'error' && <p className={styles.warning} role="status">无法读取本浏览器草稿，可能受到浏览器存储限制或草稿格式异常影响。此处不会清除原草稿。</p>}
    {status === 'found' && <><div className="form-field"><label htmlFor={fieldId}>草稿正文（只读）</label><textarea ref={textarea} id={fieldId} value={body} readOnly rows={10} aria-describedby={`${fieldId}-help`}/><p id={`${fieldId}-help`} className="field-help">此草稿仅保存在本浏览器，不是已提交版本。当前只能查看或复制，原草稿和分组信息不会被更改。</p></div><div><button className="button secondary" type="button" onClick={copyDraft}>复制草稿正文</button></div>{copyStatus && <p role="status" className="field-help">{copyStatus}</p>}</>}
  </div>;
}
