import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { MemberRole, MemberStatus } from '@prisma/client';
import { attachmentResponse } from '../src/lib/attachment-response';
import { createCourseSubpage } from '../src/lib/course-subpages';
import { db } from '../src/lib/db';
import { getGroupActivities, getGroupActivityFile, saveGroupActivity, withdrawGroupActivity } from '../src/lib/group-activities';
import {
  GroupShowcaseDraftConflictError, GroupShowcaseMaterialsError,
  getGroupShowcaseWorkspace, getPublishedGroupShowcase, getPublishedGroupShowcaseFile,
  listPublicShowcaseProjects, listPublishedGroupShowcases, publishGroupShowcase, saveGroupShowcaseDraft, withdrawGroupShowcase,
} from '../src/lib/group-showcase';
import { showcaseMaterialHref, showcasePublicationToken, showcaseReviewStatus, showcaseSelectionKey, type ShowcaseDraft, type ShowcaseSelection } from '../src/lib/group-showcase-contract';
import { getGroupWorkOrigin, groupWorkOriginParams } from '../src/lib/group-work-origin';
import { DomainError, moveStudentToGroup, setOfferingStatus } from '../src/lib/management';
import { SUBMISSION_CHUNK_BYTES } from '../src/lib/submission-contract';
import { saveSubmissionChunk } from '../src/lib/submission-upload-store';
import { addFeedback, createAssignment, getSubmissionAttachment, getSubmissionVersion, submitAssignment } from '../src/lib/teaching';
import { streamStoredFile } from '../src/lib/stored-file';
import { recordTeachingObservation } from '../src/lib/teaching-observations';
import { confirmedSubmissionInput } from './submission-fixture';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(() => db.$disconnect());

async function fixture() {
  const key = randomUUID();
  const offering = await db.courseOffering.create({ data: {
    title: '隔离展示课堂', status: 'ACTIVE',
    course: { create: { slug: key, title: '设计创新思维' } },
    term: { create: { slug: key, name: '隔离测试学期', startDate: new Date('2024-09-01'), endDate: new Date('2025-01-20') } },
  } });
  const offeringId = offering.id;
  const member = (name: string, role: MemberRole, status: MemberStatus = 'ACTIVE') => db.courseMember.create({
    data: { role, status, offering: { connect: { id: offeringId } }, user: { create: { name, email: `${randomUUID()}@test.invalid` } } },
  });
  const [teacher, ta, author, partner, reader, inactive] = await Promise.all([
    member('教师', 'TEACHER'), member('助教', 'TA'), member('记录学生', 'STUDENT'),
    member('同组学生', 'STUDENT'), member('另一组学生', 'STUDENT'), member('停用助教', 'TA', 'INACTIVE'),
  ]);
  const admin = await db.user.create({ data: { name: '全站管理员', email: `${key}@test.invalid`, isAdmin: true } });
  const [group, otherGroup] = await Promise.all(['第一组', '第二组'].map(name => db.group.create({ data: { offeringId, name } })));
  await db.groupMember.createMany({ data: [
    { groupId: group.id, courseMemberId: author.id },
    { groupId: group.id, courseMemberId: partner.id },
    { groupId: otherGroup.id, courseMemberId: reader.id },
  ].map(entry => ({ ...entry, offeringId })) });
  return { offeringId, termId: offering.termId, groupId: group.id, otherGroupId: otherGroup.id, teacher, ta, author, partner, reader, inactive, admin };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function material(name: string, content: string | Uint8Array) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : Uint8Array.from(content);
  return { name, size: bytes.length, bytes };
}

function draft(title: string, selections: ShowcaseSelection[] = []): ShowcaseDraft {
  return { title, summary: '为校园共享空间调整座椅布局。', body: '我们先测量通行宽度，再制作座椅原型并试用。', selections };
}

async function work(f: Fixture, actor = f.author.userId, groupId = f.groupId) {
  const upload = material('座椅原型.png', Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCioAAAAASUVORK5CYII=', 'base64',
  ));
  const { id } = await saveGroupActivity(actor, f.offeringId, groupId, {
    body: '工作页的原始访谈全文', nextStep: '', occurredOn: '', participantIds: [], requestId: randomUUID(),
    uploads: [upload, material('未选访谈录音.txt', '原始访谈记录')],
  });
  const activity = (await getGroupActivities(actor, f.offeringId, groupId)).find(item => item.id === id);
  assert.ok(activity);
  return { id, fileId: activity.files[0].id, upload };
}

async function assignment(f: Fixture, mode: 'GROUP' | 'INDIVIDUAL' = 'GROUP') {
  return createAssignment(f.teacher.userId, f.offeringId, {
    title: mode === 'GROUP' ? '提交原型与测试记录' : '个人可用性记录',
    description: '请提交成果及说明。', status: 'PUBLISHED', mode, dueAt: null,
  });
}

async function submit(f: Fixture, assignmentId: string, userId: string, number: number) {
  const upload = material(`测试结果-${number}.txt`, `第 ${number} 版测量结果`);
  const version = await submitAssignment(userId, f.offeringId, assignmentId, {
    ...await confirmedSubmissionInput(userId, f.offeringId, assignmentId, `第 ${number} 版作业的原始说明`),
    uploads: [upload, material(`备选测量-${number}.txt`, '未选测量明细')],
  });
  const { version: source } = await getSubmissionVersion(userId, f.offeringId, version.id);
  const chosen = source.attachments.find(file => file.name === upload.name);
  const unselected = source.attachments.find(file => file.id !== chosen?.id);
  assert.ok(chosen && unselected);
  return { id: version.id, fileId: chosen.id, unselectedId: unselected.id, upload };
}

test('展示稿提示待确认的范围，对失效选材保留已确认范围的信息', () => {
  const saved = { ...draft('本组展示'), revision: 2 };
  const classroom = { scope: 'CLASS' as const, draftRevision: 2, withdrawnAt: null };
  const internet = { scope: 'PUBLIC' as const, draftRevision: 1, withdrawnAt: null };
  assert.equal(showcaseReviewStatus({ ...saved, body: '  ' }, [], true), '草稿待补齐');
  assert.equal(showcaseReviewStatus(saved, [], true), '尚未确认');
  assert.equal(showcaseReviewStatus(saved, [classroom], true), '班内分享已确认');
  assert.equal(showcaseReviewStatus(saved, [classroom, internet], true), '有未确认更新（互联网发布）');
  assert.equal(showcaseReviewStatus(saved, [classroom, { ...internet, withdrawnAt: new Date() }], true), '班内分享已确认');
  assert.equal(showcaseReviewStatus(saved, [classroom, internet], false), '班内分享、互联网发布已确认');
  const unavailable = { hasUnavailableActivity: true };
  assert.equal(showcaseReviewStatus(saved, [], true, unavailable), '所选材料需更换');
  assert.equal(showcaseReviewStatus(saved, [classroom, internet], true, unavailable), '所选材料需更换 · 班内分享、互联网发布仍可查看');
  assert.equal(showcaseReviewStatus(saved, [classroom, { ...internet, withdrawnAt: new Date() }], true, unavailable), '所选材料需更换 · 班内分享仍可查看');
});

test('展览阅读只返回本期课次和确实在该组的学生，并保留各自阅读筛选', async () => {
  const [f, other] = await Promise.all([fixture(), fixture()]);
  const [lesson, otherLesson] = await Promise.all([
    createCourseSubpage(f.ta.userId, f.offeringId, '本期课次'),
    createCourseSubpage(other.ta.userId, other.offeringId, '另一期开课的课次'),
  ]);
  await db.groupMember.create({ data: {
    offeringId: f.offeringId, groupId: f.otherGroupId, courseMemberId: f.author.id,
    joinedAt: new Date('2024-09-01'), leftAt: new Date('2024-09-02'),
  } });
  const user = { id: f.ta.userId, isAdmin: false };
  const query = {
    fromPage: lesson.id, fromLessonRecords: '1', fromLessonRecordsWithdrawn: '1',
    fromMember: f.author.id, fromGroup: f.otherGroupId, fromMemberSearch: '  记录 学生  ', fromMemberWithdrawn: '1',
    fromRecords: '1', fromRecordsMember: '1',
  };
  const origin = await getGroupWorkOrigin(user, f.ta, f.offeringId, f.groupId, groupWorkOriginParams(query));
  assert.equal(origin.lessonReturn?.href, `/courses/${f.offeringId}/pages/${lesson.id}?view=records&includeWithdrawn=1`);
  assert.equal(origin.memberReturn?.label, '返回记录学生');
  const memberHref = new URL(origin.memberReturn!.href, 'https://example.invalid');
  assert.equal(memberHref.pathname, `/courses/${f.offeringId}/members/${f.author.id}`);
  assert.deepEqual(Object.fromEntries(memberHref.searchParams), {
    fromPage: lesson.id, fromLessonRecords: '1', fromLessonRecordsWithdrawn: '1', fromGroup: f.otherGroupId,
    fromRecords: '1', fromRecordsMember: '1', q: '记录 学生', includeWithdrawn: '1',
  });
  const wrongCourse = await getGroupWorkOrigin(user, f.ta, f.offeringId, f.groupId,
    groupWorkOriginParams({ ...query, fromPage: otherLesson.id, fromMember: other.author.id }));
  assert.equal(wrongCourse.lessonReturn, null);
  assert.equal(wrongCourse.memberReturn, null);
  assert.equal(wrongCourse.params.size, 0);

  const unrelatedMember = await getGroupWorkOrigin(user, f.ta, f.offeringId, f.groupId,
    groupWorkOriginParams({ ...query, fromMember: f.reader.id }));
  assert.equal(unrelatedMember.memberReturn, null);
  assert.equal(unrelatedMember.lessonReturn?.href, origin.lessonReturn?.href);
  assert.equal(groupWorkOriginParams({ ...query, fromPage: '//external.invalid', fromMember: 'https://external.invalid' }).size, 0);
});

test('班内和互联网各自确认，正文与所选附件保留被确认的成果版本', async () => {
  const f = await fixture();
  const { offeringId, groupId } = f;
  const activity = await work(f);
  const task = await assignment(f);
  const first = await submit(f, task.id, f.author.userId, 1);
  await addFeedback(f.ta.userId, offeringId, first.id, '仅原提交参与者可读的评语');
  await recordTeachingObservation(f.ta.userId, offeringId, {
    targetGroupId: groupId, versionId: first.id, body: '仅教学团队可读的观察', requestId: randomUUID(),
  });
  const source = await getGroupShowcaseWorkspace(f.author.userId, offeringId, groupId);
  assert.ok(source?.canEdit);
  assert.equal(source.canPublish, false);
  assert.ok(source.sources.some(item => item.source === 'ACTIVITY' && item.id === activity.id));
  assert.ok(source.sources.some(item => item.source === 'SUBMISSION' && item.id === first.id));
  assert.doesNotMatch(JSON.stringify(source.sources), /仅原提交参与者可读的评语|仅教学团队可读的观察/);

  const saved = await saveGroupShowcaseDraft(f.author.userId, offeringId, groupId, 0, draft('座椅方案第一次展示', [
    { source: 'ACTIVITY', sourceId: activity.id, fileId: activity.fileId, caption: '第一次摆放时保留入口' },
    { source: 'SUBMISSION', sourceId: first.id, fileId: first.fileId, caption: '第一次测量结果' },
  ]));
  const { revision: firstRevision, ...unchangedDraft } = saved;
  assert.deepEqual(await saveGroupShowcaseDraft(f.author.userId, offeringId, groupId, 0, unchangedDraft), saved);
  assert.deepEqual(await saveGroupShowcaseDraft(f.partner.userId, offeringId, groupId, firstRevision, unchangedDraft), saved);
  const reviewer = await getGroupShowcaseWorkspace(f.ta.userId, offeringId, groupId);
  assert.equal(reviewer?.canPublish, true);
  assert.equal(reviewer?.canEdit, false);
  assert.equal(reviewer?.draft?.revision, saved.revision);
  assert.equal(await getPublishedGroupShowcase(offeringId, groupId, 'CLASS', f.reader.userId), null);
  assert.deepEqual(await listPublishedGroupShowcases(offeringId, 'PUBLIC'), []);
  await assert.rejects(publishGroupShowcase(f.author.userId, offeringId, groupId, 'CLASS', saved.revision, null), DomainError);
  await publishGroupShowcase(f.ta.userId, offeringId, groupId, 'CLASS', saved.revision, null);

  const classroom = await getPublishedGroupShowcase(offeringId, groupId, 'CLASS', f.reader.userId);
  assert.ok(classroom);
  assert.equal(classroom.title, saved.title);
  assert.deepEqual(classroom.materials.map(item => [item.caption, item.text, item.file?.name, item.file?.image]), [
    ['第一次摆放时保留入口', null, '座椅原型.png', true],
    ['第一次测量结果', null, first.upload.name, false],
  ]);
  assert.doesNotMatch(JSON.stringify(classroom), /工作页的原始访谈全文|作业的原始说明|未选访谈录音|备选测量|仅原提交参与者可读的评语|仅教学团队可读的观察|记录学生/);
  assert.ok((await listPublishedGroupShowcases(offeringId, 'CLASS', f.reader.userId)).some(item => item.groupId === groupId));
  assert.deepEqual(await listPublishedGroupShowcases(offeringId, 'CLASS'), []);
  assert.equal(await getPublishedGroupShowcase(offeringId, groupId, 'CLASS'), null);
  assert.equal(await getPublishedGroupShowcase(offeringId, groupId, 'PUBLIC'), null);
  assert.ok(!(await listPublicShowcaseProjects()).some(item => item.groupId === groupId));
  const [image, result] = classroom.materials;
  const classFile = await getPublishedGroupShowcaseFile(offeringId, groupId, 'CLASS', classroom.publicationId, result.id, f.reader.userId);
  assert.ok(classFile);
  assert.deepEqual(new Uint8Array(await new Response(streamStoredFile(classFile)).arrayBuffer()), first.upload.bytes);
  assert.equal(await getPublishedGroupShowcaseFile(offeringId, groupId, 'CLASS', classroom.publicationId, result.id), null);
  assert.equal(await getPublishedGroupShowcaseFile(offeringId, groupId, 'PUBLIC', classroom.publicationId, result.id), null);
  assert.equal(await getPublishedGroupShowcaseFile(offeringId, groupId, 'CLASS', classroom.publicationId, first.unselectedId, f.reader.userId), null);
  assert.equal(await getGroupActivityFile(f.reader.userId, offeringId, groupId, activity.id, activity.fileId), null);
  assert.equal(await getSubmissionAttachment(f.reader.userId, offeringId, task.id, first.id, first.fileId), null);

  const second = await submit(f, task.id, f.author.userId, 2);
  const newer = await saveGroupShowcaseDraft(f.partner.userId, offeringId, groupId, saved.revision, draft('座椅方案对外展示', [
    { source: 'SUBMISSION', sourceId: second.id, fileId: null, caption: '第二次观察的成果说明' },
    { source: 'SUBMISSION', sourceId: second.id, fileId: second.fileId, caption: '第二次测量结果' },
    { source: 'ACTIVITY', sourceId: activity.id, fileId: activity.fileId, caption: '保留入口的座椅原型' },
  ]));
  await assert.rejects(publishGroupShowcase(f.ta.userId, offeringId, groupId, 'PUBLIC', saved.revision, null), DomainError);
  await publishGroupShowcase(f.teacher.userId, offeringId, groupId, 'PUBLIC', newer.revision, null);
  const published = await getPublishedGroupShowcase(offeringId, groupId, 'PUBLIC');
  assert.ok(published);
  assert.equal(published.title, newer.title);
  assert.equal(published.materials[0].text, '第 2 版作业的原始说明');
  assert.equal(published.materials[0].file, null);
  const publicFile = await getPublishedGroupShowcaseFile(offeringId, groupId, 'PUBLIC', published.publicationId, published.materials[1].id);
  assert.ok(publicFile);
  assert.deepEqual(new Uint8Array(await new Response(streamStoredFile(publicFile)).arrayBuffer()), second.upload.bytes);
  assert.equal(await getPublishedGroupShowcaseFile(offeringId, groupId, 'CLASS', published.publicationId, published.materials[1].id, f.reader.userId), null);
  assert.equal(await getPublishedGroupShowcaseFile(offeringId, f.otherGroupId, 'PUBLIC', published.publicationId, published.materials[1].id), null);
  assert.equal(await getPublishedGroupShowcaseFile(randomUUID(), groupId, 'PUBLIC', published.publicationId, published.materials[1].id), null);
  assert.equal(await getSubmissionAttachment(f.reader.userId, offeringId, task.id, second.id, second.fileId), null);
  assert.ok(await getPublishedGroupShowcaseFile(offeringId, groupId, 'CLASS', classroom.publicationId, image.id, f.reader.userId));
  assert.deepEqual(await getPublishedGroupShowcase(offeringId, groupId, 'CLASS', f.reader.userId), classroom);
  assert.deepEqual((await listPublishedGroupShowcases(offeringId, 'PUBLIC')).map(item => item.title), [newer.title]);
  const card = (await listPublicShowcaseProjects()).find(item => item.groupId === groupId);
  assert.ok(card);
  assert.equal(card.offeringId, offeringId);
  assert.equal(card.title, newer.title);
  assert.equal(card.summary, newer.summary);
  assert.ok(card.publishedAt instanceof Date);
  assert.deepEqual(card.term, { id: f.termId, name: '隔离测试学期', startDate: new Date('2024-09-01') });
  assert.deepEqual(card.cover, {
    src: showcaseMaterialHref(offeringId, groupId, 'PUBLIC', published.publicationId, published.materials[2].id),
    alt: '保留入口的座椅原型',
  });

  const other = await fixture();
  const withoutImage = await saveGroupShowcaseDraft(other.author.userId, other.offeringId, other.groupId, 0, draft('另一期开课公开作品'));
  await publishGroupShowcase(other.teacher.userId, other.offeringId, other.groupId, 'PUBLIC', withoutImage.revision, null);
  await setOfferingStatus(other.teacher.userId, other.offeringId, 'ARCHIVED');
  const recent = await listPublicShowcaseProjects(1);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].groupId, other.groupId);
  assert.equal(recent[0].cover, null);

  await setOfferingStatus(f.teacher.userId, offeringId, 'DRAFT');
  assert.deepEqual(await listPublishedGroupShowcases(offeringId, 'PUBLIC'), []);
  assert.ok(!(await listPublicShowcaseProjects()).some(item => item.groupId === groupId));
  assert.equal(await getPublishedGroupShowcase(offeringId, groupId, 'PUBLIC'), null);
  assert.equal(await getPublishedGroupShowcaseFile(offeringId, groupId, 'PUBLIC', published.publicationId, published.materials[1].id), null);
  await setOfferingStatus(f.teacher.userId, offeringId, 'ACTIVE');
  assert.ok((await listPublicShowcaseProjects()).some(item => item.groupId === groupId));
  const update = await saveGroupShowcaseDraft(f.partner.userId, offeringId, groupId, newer.revision, draft('座椅方案对外更新'));
  await publishGroupShowcase(f.teacher.userId, offeringId, groupId, 'PUBLIC', update.revision, published.publicationId);
  assert.deepEqual((await listPublicShowcaseProjects()).filter(item => item.groupId === groupId).map(item => [item.title, item.cover]), [[update.title, null]]);
  assert.equal(await getPublishedGroupShowcaseFile(offeringId, groupId, 'PUBLIC', published.publicationId, published.materials[2].id), null);
  const replacement = await getPublishedGroupShowcase(offeringId, groupId, 'PUBLIC');
  assert.ok(replacement);
  await withdrawGroupShowcase(f.teacher.userId, offeringId, groupId, 'PUBLIC', replacement.publicationId);
  assert.ok(!(await listPublicShowcaseProjects()).some(item => item.groupId === groupId));
  assert.equal(await getPublishedGroupShowcaseFile(offeringId, groupId, 'PUBLIC', published.publicationId, published.materials[1].id), null);
  assert.deepEqual(await getPublishedGroupShowcase(offeringId, groupId, 'CLASS', f.reader.userId), classroom);
});

test('只接受本组同期开课的过程和具体正式成果，组籍变化即时限制草稿和选材', async () => {
  const f = await fixture();
  const { offeringId, groupId } = f;
  const activity = await work(f);
  const other = await work(f, f.reader.userId, f.otherGroupId);
  const task = await assignment(f);
  const first = await submit(f, task.id, f.author.userId, 1);
  const second = await submit(f, task.id, f.author.userId, 2);
  const personal = await assignment(f, 'INDIVIDUAL');
  const personalWork = await submit(f, personal.id, f.author.userId, 1);
  const otherResult = await submit(f, task.id, f.reader.userId, 1);
  const otherOffering = await fixture();
  const foreignActivity = await work(otherOffering);
  const { id: noteId } = await recordTeachingObservation(f.ta.userId, offeringId, {
    targetGroupId: groupId, body: '内部观察', requestId: randomUUID(),
  });
  const sources = await getGroupShowcaseWorkspace(f.author.userId, offeringId, groupId);
  assert.ok(sources);
  assert.deepEqual(new Set(sources.sources.map(source => source.id)), new Set([activity.id, first.id, second.id]));

  const invalid: ShowcaseSelection[] = [
    { source: 'ACTIVITY', sourceId: other.id, fileId: null, caption: '' },
    { source: 'ACTIVITY', sourceId: foreignActivity.id, fileId: null, caption: '' },
    { source: 'ACTIVITY', sourceId: noteId, fileId: null, caption: '' },
    { source: 'SUBMISSION', sourceId: personalWork.id, fileId: personalWork.fileId, caption: '' },
    { source: 'SUBMISSION', sourceId: otherResult.id, fileId: otherResult.fileId, caption: '' },
    { source: 'SUBMISSION', sourceId: first.id, fileId: second.fileId, caption: '' },
  ];
  for (const selection of invalid) {
    await assert.rejects(saveGroupShowcaseDraft(f.author.userId, offeringId, groupId, 0, draft('不可选材料', [selection])), DomainError);
  }
  assert.equal((await getGroupShowcaseWorkspace(f.author.userId, offeringId, groupId))?.draft, null);
  assert.equal(await getGroupShowcaseWorkspace(f.reader.userId, offeringId, groupId), null);
  assert.equal(await getGroupShowcaseWorkspace(f.admin.id, offeringId, groupId), null);
  assert.equal(await getGroupShowcaseWorkspace(f.inactive.userId, offeringId, groupId), null);

  const saved = await saveGroupShowcaseDraft(f.author.userId, offeringId, groupId, 0, draft('保留第一次正式成果', [
    { source: 'SUBMISSION', sourceId: first.id, fileId: first.fileId, caption: '第一次测量' },
  ]));
  await assert.rejects(publishGroupShowcase(f.admin.id, offeringId, groupId, 'PUBLIC', saved.revision, null), DomainError);
  await assert.rejects(publishGroupShowcase(f.inactive.userId, offeringId, groupId, 'PUBLIC', saved.revision, null), DomainError);
  await moveStudentToGroup(f.teacher.userId, offeringId, f.otherGroupId, f.author.id);
  assert.equal(await getGroupShowcaseWorkspace(f.author.userId, offeringId, groupId), null);
  await assert.rejects(saveGroupShowcaseDraft(f.author.userId, offeringId, groupId, saved.revision, draft('离组后尝试改写')), DomainError);
  await moveStudentToGroup(f.teacher.userId, offeringId, groupId, f.reader.id);
  const joined = await getGroupShowcaseWorkspace(f.reader.userId, offeringId, groupId);
  assert.equal(joined?.draft?.revision, saved.revision);
  assert.equal(joined?.draft?.selections[0].sourceId, first.id);
  assert.ok(joined?.canEdit);
  await publishGroupShowcase(f.ta.userId, offeringId, groupId, 'CLASS', saved.revision, null);
  const published = await getPublishedGroupShowcase(offeringId, groupId, 'CLASS', f.reader.userId);
  assert.equal(published?.materials[0].file?.name, first.upload.name);
});

test('同一范围的确认与撤回核对当前版本，撤回后旧审核无法重新公开', async () => {
  const f = await fixture();
  const { offeringId, groupId } = f;
  const initial = await saveGroupShowcaseDraft(f.author.userId, offeringId, groupId, 0, draft('小组初稿'));
  const saves = await Promise.allSettled([
    saveGroupShowcaseDraft(f.author.userId, offeringId, groupId, initial.revision, draft('组员一编辑')),
    saveGroupShowcaseDraft(f.partner.userId, offeringId, groupId, initial.revision, draft('组员二编辑')),
  ]);
  const saved = saves.find(item => item.status === 'fulfilled');
  const rejected = saves.find(item => item.status === 'rejected');
  assert.ok(saved && rejected?.reason instanceof DomainError);
  const revision = saved.value.revision;
  const publish = (actor: string, token: string | null) => publishGroupShowcase(actor, offeringId, groupId, 'PUBLIC', revision, token);
  const confirmations = await Promise.allSettled([publish(f.ta.userId, null), publish(f.teacher.userId, null)]);
  assert.equal(confirmations.filter(item => item.status === 'fulfilled').length, 1);
  assert.ok(confirmations.some(item => item.status === 'rejected' && item.reason instanceof DomainError));
  const published = await getPublishedGroupShowcase(offeringId, groupId, 'PUBLIC');
  assert.ok(published);
  assert.equal(published.title, saved.value.title);

  await withdrawGroupShowcase(f.ta.userId, offeringId, groupId, 'PUBLIC', published.publicationId);
  await withdrawGroupShowcase(f.ta.userId, offeringId, groupId, 'PUBLIC', published.publicationId);
  assert.equal(await getPublishedGroupShowcase(offeringId, groupId, 'PUBLIC'), null);
  await assert.rejects(publish(f.teacher.userId, published.publicationId), DomainError);
  const workspace = await getGroupShowcaseWorkspace(f.teacher.userId, offeringId, groupId);
  assert.ok(workspace);
  const token = showcasePublicationToken(workspace.publications.PUBLIC);
  assert.equal(token, published.publicationId + ':withdrawn');
  await publish(f.teacher.userId, token);
  const republished = await getPublishedGroupShowcase(offeringId, groupId, 'PUBLIC');
  assert.ok(republished);
  assert.notEqual(republished.publicationId, published.publicationId);
  await assert.rejects(withdrawGroupShowcase(f.ta.userId, offeringId, groupId, 'PUBLIC', published.publicationId), DomainError);
  assert.equal((await getPublishedGroupShowcase(offeringId, groupId, 'PUBLIC'))?.publicationId, republished.publicationId);
});

test('过程材料撤回会挡住新的确认，已确认快照可继续读并由教学团队按范围撤回', async () => {
  const f = await fixture();
  const { offeringId, groupId } = f;
  const activity = await work(f);
  const saved = await saveGroupShowcaseDraft(f.author.userId, offeringId, groupId, 0, draft('本组展示', [
    { source: 'ACTIVITY', sourceId: activity.id, fileId: activity.fileId, caption: '第一次座椅摆放' },
  ]));
  await publishGroupShowcase(f.ta.userId, offeringId, groupId, 'CLASS', saved.revision, null);
  const classroom = await getPublishedGroupShowcase(offeringId, groupId, 'CLASS', f.reader.userId);
  assert.ok(classroom);
  const file = () => getPublishedGroupShowcaseFile(offeringId, groupId, 'CLASS', classroom.publicationId, classroom.materials[0].id, f.reader.userId);
  await assert.rejects(db.fileObject.update({
    where: { id: activity.fileId }, data: { originalName: '替换后的原型.txt', bytes: new Uint8Array([1]), sizeBytes: 1 },
  }));
  await withdrawGroupActivity(f.author.userId, offeringId, groupId, activity.id);
  assert.equal(await getGroupActivityFile(f.author.userId, offeringId, groupId, activity.id, activity.fileId), null);
  await assert.rejects(publishGroupShowcase(f.teacher.userId, offeringId, groupId, 'PUBLIC', saved.revision, null), DomainError);
  assert.equal(await getPublishedGroupShowcase(offeringId, groupId, 'PUBLIC'), null);
  const original = await file();
  assert.ok(original);
  assert.deepEqual(new Uint8Array(await new Response(streamStoredFile(original)).arrayBuffer()), activity.upload.bytes);

  await setOfferingStatus(f.teacher.userId, offeringId, 'ARCHIVED');
  const workspace = await getGroupShowcaseWorkspace(f.ta.userId, offeringId, groupId);
  assert.equal(workspace?.canPublish, false);
  assert.equal(workspace?.canWithdraw, true);
  assert.deepEqual(await getPublishedGroupShowcase(offeringId, groupId, 'CLASS', f.reader.userId), classroom);
  assert.ok(await file());
  await assert.rejects(saveGroupShowcaseDraft(f.author.userId, offeringId, groupId, saved.revision, draft('尝试修改往期展示')), DomainError);
  await assert.rejects(withdrawGroupShowcase(f.author.userId, offeringId, groupId, 'CLASS', classroom.publicationId), DomainError);
  await withdrawGroupShowcase(f.ta.userId, offeringId, groupId, 'CLASS', classroom.publicationId);
  assert.equal(await file(), null);
  assert.deepEqual(await listPublishedGroupShowcases(offeringId, 'CLASS', f.reader.userId), []);
});

test('公开展示读取分块成果的原字节，撤回后旧附件地址失效', async () => {
  const f = await fixture();
  const { offeringId, groupId } = f;
  const author = f.author.userId;
  const task = await assignment(f);
  const fileId = randomUUID();
  const name = '原型测试报告.pdf';
  const bytes = new Uint8Array(SUBMISSION_CHUNK_BYTES + 7);
  bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
  const start = SUBMISSION_CHUNK_BYTES - 2;
  const end = SUBMISSION_CHUNK_BYTES + 2;
  bytes.set([1, 2, 3, 4, 5], start);
  for (const index of [0, 1]) {
    await saveSubmissionChunk(author, offeringId, task.id, fileId, {
      name, size: bytes.length, index,
      bytes: bytes.subarray(index * SUBMISSION_CHUNK_BYTES, (index + 1) * SUBMISSION_CHUNK_BYTES),
    });
  }
  const version = await submitAssignment(author, offeringId, task.id, {
    ...await confirmedSubmissionInput(author, offeringId, task.id, '正式交回的报告'),
    stagedFileIds: [fileId],
  });
  const saved = await saveGroupShowcaseDraft(author, offeringId, groupId, 0, draft('原型测试公开报告', [
    { source: 'SUBMISSION', sourceId: version.id, fileId, caption: '冻结的正式成果' },
  ]));
  await publishGroupShowcase(f.teacher.userId, offeringId, groupId, 'PUBLIC', saved.revision, null);

  const published = await getPublishedGroupShowcase(offeringId, groupId, 'PUBLIC');
  assert.ok(published);
  const [asset] = published.materials;
  const source = () => getPublishedGroupShowcaseFile(offeringId, groupId, 'PUBLIC', published.publicationId, asset.id, f.reader.userId);
  const file = await source();
  assert.ok(file?.chunked);
  assert.equal(file.name, name);
  assert.equal(await getSubmissionAttachment(f.reader.userId, offeringId, task.id, version.id, fileId), null);
  const href = showcaseMaterialHref(offeringId, groupId, 'PUBLIC', published.publicationId, asset.id);
  const response = await attachmentResponse(new Request(`https://course.example${href}`, {
    headers: { Range: `bytes=${start}-${end}` },
  }), file, 'showcase');
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Type'), 'application/pdf');
  assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${end}/${bytes.length}`);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes.subarray(start, end + 1));

  await withdrawGroupShowcase(f.ta.userId, offeringId, groupId, 'PUBLIC', published.publicationId);
  assert.equal(await source(), null);
  const original = await getSubmissionAttachment(author, offeringId, task.id, version.id, fileId);
  assert.ok(original);
  assert.deepEqual(new Uint8Array(await new Response(streamStoredFile(original)).arrayBuffer()), bytes);
});

test('组员可对照最新展示稿，继续拒绝陈旧修订并指出失效的具体材料', async () => {
  const f = await fixture();
  const { offeringId, groupId } = f;
  const save = (actor: string, revision: number, next: ShowcaseDraft) => saveGroupShowcaseDraft(actor, offeringId, groupId, revision, next);
  const initial = await save(f.author.userId, 0, draft('小组初稿'));
  const removed = await work(f, f.partner.userId);
  const retained = await work(f);
  const selected: ShowcaseSelection[] = [
    { source: 'ACTIVITY', sourceId: removed.id, fileId: removed.fileId, caption: '组员补充的原型说明' },
    { source: 'ACTIVITY', sourceId: retained.id, fileId: retained.fileId, caption: '仍可读的原型' },
    { source: 'ACTIVITY', sourceId: removed.id, fileId: null, caption: '组员补充的文字说明' },
  ];
  const newer = await save(f.partner.userId, initial.revision, draft('组员改的标题', selected));
  const merged = { ...newer, body: '从初版试用到第二次测量，保留两位组员的修改。' };
  await assert.rejects(save(f.author.userId, initial.revision, merged), error => {
    assert.ok(error instanceof GroupShowcaseDraftConflictError);
    assert.deepEqual(error.current, newer);
    assert.ok(error.sources.find(item => item.id === removed.id)?.files.some(file => file.id === removed.fileId));
    return true;
  });
  await assert.rejects(save(f.reader.userId, initial.revision, merged), error => {
    assert.ok(error instanceof DomainError);
    assert.ok(!(error instanceof GroupShowcaseDraftConflictError));
    return true;
  });

  const third = await save(f.partner.userId, newer.revision, { ...newer, summary: '最新的项目简介' });
  await assert.rejects(save(f.author.userId, newer.revision, merged), error => {
    assert.ok(error instanceof GroupShowcaseDraftConflictError);
    assert.deepEqual(error.current, third);
    return true;
  });
  await withdrawGroupActivity(f.partner.userId, offeringId, groupId, removed.id);
  const currentEdit = { ...merged, summary: third.summary };
  await assert.rejects(save(f.author.userId, third.revision, currentEdit), error => {
    assert.ok(error instanceof GroupShowcaseMaterialsError);
    assert.deepEqual(error.selectionKeys, [showcaseSelectionKey(selected[0]), showcaseSelectionKey(selected[2])]);
    return true;
  });
  assert.deepEqual((await getGroupShowcaseWorkspace(f.author.userId, offeringId, groupId))?.draft, third);

  const repaired = { ...currentEdit, selections: [selected[1]] };
  const saved = await save(f.author.userId, third.revision, repaired);
  assert.deepEqual(saved, { ...repaired, revision: third.revision + 1 });
  assert.deepEqual(await save(f.author.userId, third.revision, repaired), saved);
});
