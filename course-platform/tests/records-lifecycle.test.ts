import { confirmedSubmissionInput } from './submission-fixture';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { db } from '../src/lib/db';
import { DomainError } from '../src/lib/management';
import { AssignmentRevisionConflictError, createAssignment, updateAssignment, changeAssignmentStatus, submitAssignment, addFeedback, getAssignmentDetail, getAssignmentIndex, getSubmissionVersion, type AssignmentInput } from '../src/lib/teaching';
import { createResource, ResourceRevisionConflictError, updateResource, changeResourceStatus, getCourseResource } from '../src/lib/resource-service';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(async () => { await db.$disconnect(); });
const denied = (promise: Promise<unknown>) => assert.rejects(promise, DomainError);
const assignmentInput = (extra: Partial<AssignmentInput> = {}): AssignmentInput => ({ title: '访谈作业', description: '采访三人', mode: 'INDIVIDUAL', status: 'PUBLISHED', dueAt: null, ...extra });
const resourceInput = { title: '访谈资料', body: '记录证据', url: '', status: 'PUBLISHED' as const };

async function fixture() {
  const key = randomUUID();
  const [teacher, student, peer, ta, admin] = await Promise.all(['teacher', 'student', 'peer', 'ta', 'admin'].map(name => db.user.create({ data: { email: `${name}-${key}@test.invalid`, name, isAdmin: name === 'admin' } })));
  const course = await db.course.create({ data: { slug: key, title: '记录生命周期' } });
  const term = await db.term.create({ data: { slug: key, name: key, startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } });
  const offering = await db.courseOffering.create({ data: { courseId: course.id, termId: term.id, title: '测试开课', status: 'ACTIVE' } });
  const members = [];
  for (const [user, role] of [[teacher, 'TEACHER'], [student, 'STUDENT'], [peer, 'STUDENT'], [ta, 'TA']] as const) members.push(await db.courseMember.create({ data: { offeringId: offering.id, userId: user.id, role } }));
  return { teacher, student, peer, ta, admin, offering, studentMember: members[1] };
}

test('创建作业和资料的网络重试按作者、开课与规范化内容复用，拒绝标识复用并发不重复', async () => {
  const f = await fixture(), other = await fixture();
  const key = randomUUID();
  const created = await Promise.all([
    createAssignment(f.teacher.id, f.offering.id, assignmentInput({ title: ' 访谈作业 ' }), key),
    createAssignment(f.teacher.id, f.offering.id, assignmentInput({ maxScore: 100 }), key),
  ]);
  assert.equal(created[0].id, created[1].id);
  assert.equal(await db.assignment.count({ where: { offeringId: f.offering.id } }), 1);
  assert.equal(await db.assignmentRevision.count({ where: { assignmentId: created[0].id } }), 1);
  for (const attempt of [
    () => createAssignment(f.teacher.id, f.offering.id, assignmentInput({ description: '不同要求' }), key),
    () => createAssignment(f.admin.id, f.offering.id, assignmentInput(), key),
    () => createAssignment(other.teacher.id, other.offering.id, assignmentInput(), key),
  ]) await denied(attempt());
  const changed = await updateAssignment(f.teacher.id, f.offering.id, created[0].id, assignmentInput({ title: '已修改' }), 1);
  assert.equal((await createAssignment(f.teacher.id, f.offering.id, assignmentInput(), key)).revision, changed.revision);
  const rKey = randomUUID();
  const resources = await Promise.all([
    createResource(f.teacher.id, f.offering.id, { ...resourceInput, title: ' 访谈资料 ' }, rKey),
    createResource(f.teacher.id, f.offering.id, resourceInput, rKey),
  ]);
  assert.equal(resources[0].id, resources[1].id);
  await denied(createResource(f.admin.id, f.offering.id, resourceInput, rKey));
  await denied(createResource(other.teacher.id, other.offering.id, resourceInput, rKey));
  await denied(createResource(f.teacher.id, f.offering.id, { ...resourceInput, body: '不同资料' }, rKey));
  assert.equal(await db.resource.count({ where: { offeringId: f.offering.id } }), 1);
});

test('作业结束与资料撤回独立于主页版本，旧表单不能覆盖记录新状态', async () => {
  const f = await fixture();
  const assignment = await createAssignment(f.teacher.id, f.offering.id, assignmentInput({ dueAt: new Date('2031-01-01') }));
  const resource = await createResource(f.teacher.id, f.offering.id, resourceInput);
  const document = { version: 1, blocks: [{ id: 'p', type: 'paragraph', content: [{ type: 'text', text: '助教新保存的文字' }], children: [] }] };
  await db.courseFocus.create({ data: { offeringId: f.offering.id, title: '页面', document, revision: 8,
    assignments: { create: { assignmentId: assignment.id } }, resources: { create: { resourceId: resource.id } } } });
  const ended = await changeAssignmentStatus(f.teacher.id, f.offering.id, assignment.id, { status: 'ARCHIVED', expectedRevision: 1 });
  const withdrawn = await changeResourceStatus(f.teacher.id, f.offering.id, resource.id, { status: 'ARCHIVED', expectedRevision: 1 });
  assert.equal(ended.title, assignment.title); assert.deepEqual(ended.dueAt, assignment.dueAt);
  assert.equal(withdrawn.body, resource.body); assert.equal(withdrawn.revision, 2);
  assert.equal((await db.courseFocus.findUniqueOrThrow({ where: { offeringId: f.offering.id } })).revision, 8);
  assert.deepEqual((await db.courseFocus.findUniqueOrThrow({ where: { offeringId: f.offering.id } })).document, document);
  await assert.rejects(updateAssignment(f.teacher.id, f.offering.id, assignment.id, assignmentInput(), 1), AssignmentRevisionConflictError);
  await denied(changeAssignmentStatus(f.teacher.id, f.offering.id, assignment.id, { status: 'PUBLISHED', expectedRevision: 1 }));
  await assert.rejects(updateResource(f.teacher.id, f.offering.id, resource.id, resourceInput, 1), ResourceRevisionConflictError);
  await denied(updateResource(f.teacher.id, f.offering.id, resource.id, resourceInput, undefined as unknown as number));
  await denied(updateAssignment(f.teacher.id, f.offering.id, assignment.id, assignmentInput(), undefined as unknown as number));
  assert.equal(await db.assignmentRevision.count({ where: { assignmentId: assignment.id } }), 2);
  assert.equal((await getAssignmentDetail(f.student.id, f.offering.id, assignment.id)).canSubmit, false);
});

test('同版本并发修改只有一份成功，作业历史与资料revision不会被静默覆盖', async () => {
  const f = await fixture();
  const assignment = await createAssignment(f.teacher.id, f.offering.id, assignmentInput());
  const results = await Promise.allSettled(['甲', '乙'].map(title => updateAssignment(f.teacher.id, f.offering.id, assignment.id, assignmentInput({ title }), assignment.revision)));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.filter(row => row.status === 'rejected' && row.reason instanceof AssignmentRevisionConflictError).length, 1);
  assert.equal(await db.assignmentRevision.count({ where: { assignmentId: assignment.id } }), 2);
  const resource = await createResource(f.teacher.id, f.offering.id, resourceInput);
  const rResults = await Promise.allSettled(['甲', '乙'].map(title => updateResource(f.teacher.id, f.offering.id, resource.id, { ...resourceInput, title }, resource.revision)));
  assert.equal(rResults.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(rResults.filter(row => row.status === 'rejected' && row.reason instanceof ResourceRevisionConflictError).length, 1);
});

test('取消要求已发布与原因，移出应交未交统计但保留提交反馈，恢复会留下版本', async () => {
  const f = await fixture();
  await denied(createAssignment(f.teacher.id, f.offering.id, assignmentInput({ status: 'CANCELLED', cancellationReason: '课程调整' })));
  const draft = await createAssignment(f.teacher.id, f.offering.id, assignmentInput({ status: 'DRAFT' }));
  await denied(changeAssignmentStatus(f.teacher.id, f.offering.id, draft.id, { status: 'CANCELLED', cancellationReason: '课程调整', expectedRevision: 1 }));
  const assignment = await createAssignment(f.teacher.id, f.offering.id, assignmentInput());
  const version = await submitAssignment(f.student.id, f.offering.id, assignment.id, await confirmedSubmissionInput(f.student.id, f.offering.id, assignment.id, '三人的采访'));
  await addFeedback(f.teacher.id, f.offering.id, version.id, '已有反馈');
  await denied(changeAssignmentStatus(f.teacher.id, f.offering.id, assignment.id, { status: 'CANCELLED', expectedRevision: 1 }));
  await denied(changeAssignmentStatus(f.ta.id, f.offering.id, assignment.id, { status: 'CANCELLED', cancellationReason: '课程调整', expectedRevision: 1 }));
  const cancelled = await changeAssignmentStatus(f.teacher.id, f.offering.id, assignment.id, { status: 'CANCELLED', cancellationReason: ' 天气原因，免交 ', expectedRevision: 1 });
  assert.equal(cancelled.cancellationReason, '天气原因，免交');
  const staff = await getAssignmentDetail(f.teacher.id, f.offering.id, assignment.id);
  assert.equal(staff.summary?.totalExpectedCount, 0); assert.equal(staff.summary?.submittedCount, 1);
  assert.equal(staff.reviewQueue.length, 1); assert.ok(staff.reviewQueue.every(row => row.latestVersionId));
  const student = await getAssignmentDetail(f.student.id, f.offering.id, assignment.id);
  assert.equal(student.progress?.state, 'CANCELLED'); assert.equal(student.canSubmit, false);
  assert.equal(student.versions[0].feedback[0].body, '已有反馈');
  assert.equal((await getAssignmentIndex(f.peer.id, f.offering.id)).assignments.find(row => row.id === assignment.id)?.progress?.state, 'CANCELLED');
  await denied(submitAssignment(f.peer.id, f.offering.id, assignment.id, await confirmedSubmissionInput(f.peer.id, f.offering.id, assignment.id, '仍要提交')));
  await denied(changeAssignmentStatus(f.teacher.id, f.offering.id, assignment.id, { status: 'ARCHIVED', expectedRevision: cancelled.revision }));
  const restored = await changeAssignmentStatus(f.teacher.id, f.offering.id, assignment.id, { status: 'PUBLISHED', expectedRevision: cancelled.revision });
  assert.equal(restored.cancellationReason, null);
  const after = await getAssignmentDetail(f.student.id, f.offering.id, assignment.id);
  assert.deepEqual(after.revisionHistory.map(row => row.status), ['PUBLISHED', 'CANCELLED', 'PUBLISHED']);
  assert.equal(after.revisionHistory[1].cancellationReason, '天气原因，免交'); assert.equal(after.canSubmit, true);
});

test('提交绑定当时不可变要求版本，学生看不到发布前草稿，后来修改不重写旧要求', async () => {
  const f = await fixture();
  const draft = await createAssignment(f.teacher.id, f.offering.id, assignmentInput({ status: 'DRAFT', description: '内部草稿秘密' }));
  const originalDueAt = new Date('2035-11-05');
  const published = await updateAssignment(f.teacher.id, f.offering.id, draft.id, assignmentInput({ dueAt: originalDueAt, maxScore: 100 }), draft.revision);
  const first = await submitAssignment(f.student.id, f.offering.id, draft.id, await confirmedSubmissionInput(f.student.id, f.offering.id, draft.id, '按三人要求完成'));
  assert.equal(first.assignmentRevision?.revision, published.revision);
  const changed = await updateAssignment(f.teacher.id, f.offering.id, draft.id, assignmentInput({ description: '采访五人', dueAt: new Date('2035-11-08'), maxScore: 50.29 }), published.revision);
  const second = await submitAssignment(f.student.id, f.offering.id, draft.id, await confirmedSubmissionInput(f.student.id, f.offering.id, draft.id, '按五人要求补交'));
  assert.equal(second.assignmentRevision?.description, '采访五人'); assert.equal(second.assignmentRevision?.maxScore, 50.29);
  const old = await getSubmissionVersion(f.student.id, f.offering.id, first.id);
  assert.equal(old.version.assignmentRevision?.description, '采访三人'); assert.equal(old.version.assignmentRevision?.maxScore, 100);
  assert.deepEqual(old.version.assignmentRevision?.dueAt, originalDueAt);
  assert.equal(old.assignment.description, '采访五人');
  const student = await getAssignmentDetail(f.student.id, f.offering.id, draft.id);
  assert.deepEqual(student.revisionHistory.map(row => row.revision), [changed.revision, published.revision]);
  assert.ok(student.revisionHistory.every(row => row.status !== 'DRAFT'));
  const staff = await getAssignmentDetail(f.ta.id, f.offering.id, draft.id);
  assert.equal(staff.revisionHistory.at(-1)?.description, '内部草稿秘密');
  await assert.rejects(db.assignmentRevision.update({ where: { id: first.assignmentRevisionId! }, data: { description: '篡改' } }));
  await assert.rejects(db.assignmentRevision.delete({ where: { id: second.assignmentRevisionId! } }));
  await assert.rejects(db.submissionVersion.update({ where: { id: first.id }, data: { assignmentRevisionId: second.assignmentRevisionId } }));
  const other = await createAssignment(f.teacher.id, f.offering.id, assignmentInput({ title: '另一个作业' }));
  const otherContainer = await db.submission.create({ data: { offeringId: f.offering.id, assignmentId: other.id, courseMemberId: f.studentMember.id } });
  await assert.rejects(db.submissionVersion.create({ data: { offeringId: f.offering.id, submissionId: otherContainer.id, submittedById: f.studentMember.id, version: 1, body: '错误绑定', assignmentRevisionId: first.assignmentRevisionId } }));
});

test('旧提交未知要求保持null，新建立的基线不能反填旧提交', async () => {
  const f = await fixture();
  const assignment = await db.assignment.create({ data: { ...assignmentInput(), offeringId: f.offering.id } });
  const submission = await db.submission.create({ data: { offeringId: f.offering.id, assignmentId: assignment.id, courseMemberId: f.studentMember.id } });
  const legacy = await db.submissionVersion.create({ data: { offeringId: f.offering.id, submissionId: submission.id, submittedById: f.studentMember.id, version: 1, body: '旧提交' } });
  await db.submissionParticipant.create({ data: { offeringId: f.offering.id, versionId: legacy.id, courseMemberId: f.studentMember.id } });
  await db.submissionVersion.update({ where: { id: legacy.id }, data: { finalizedAt: new Date() } });
  await updateAssignment(f.teacher.id, f.offering.id, assignment.id, assignmentInput({ description: '新要求' }), 1);
  const old = await getSubmissionVersion(f.student.id, f.offering.id, legacy.id);
  assert.equal(old.version.assignmentRevisionId, null); assert.equal(old.version.assignmentRevision, null);
  const history = (await getAssignmentDetail(f.teacher.id, f.offering.id, assignment.id)).revisionHistory;
  assert.equal(history.at(-1)?.isBaseline, true); assert.equal(history.at(-1)?.actorUserId, null);
  const latest = await submitAssignment(f.student.id, f.offering.id, assignment.id, await confirmedSubmissionInput(f.student.id, f.offering.id, assignment.id, '新提交'));
  assert.equal(latest.assignmentRevision?.description, '新要求');
  assert.equal((await db.submissionVersion.findUniqueOrThrow({ where: { id: legacy.id } })).assignmentRevisionId, null);
});

test('资料首次发布时间跨撤回和退草稿保留，TA未获得隐藏资料读取权', async () => {
  const f = await fixture();
  const draft = await createResource(f.teacher.id, f.offering.id, { ...resourceInput, status: 'DRAFT' });
  assert.equal(draft.firstPublishedAt, null);
  const published = await changeResourceStatus(f.teacher.id, f.offering.id, draft.id, { status: 'PUBLISHED', expectedRevision: draft.revision });
  assert.ok(published.firstPublishedAt);
  const withdrawn = await changeResourceStatus(f.teacher.id, f.offering.id, draft.id, { status: 'ARCHIVED', expectedRevision: published.revision });
  const again = await changeResourceStatus(f.teacher.id, f.offering.id, draft.id, { status: 'DRAFT', expectedRevision: withdrawn.revision });
  assert.deepEqual(again.firstPublishedAt, published.firstPublishedAt);
  assert.equal((await getCourseResource(f.ta.id, f.offering.id, draft.id)).resource, null);
  await denied(changeResourceStatus(f.ta.id, f.offering.id, draft.id, { status: 'PUBLISHED', expectedRevision: again.revision }));
});

test('真实迁移建立明确baseline但不伪造旧提交要求或资源首次发布时间', async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const schema = `migration_${randomUUID().replaceAll('-', '')}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const migrations = path.resolve('prisma/migrations');
    for (const entry of (await readdir(migrations)).filter(name => /^\d/.test(name) && name < '20261030000000_record_lifecycle').sort()) await client.query(await readFile(path.join(migrations, entry, 'migration.sql'), 'utf8'));
    await client.query(`
      INSERT INTO "User" (id,email,name) VALUES ('u','legacy@test.invalid','旧学生');
      INSERT INTO "Course" (id,slug,title) VALUES ('c','legacy','旧课程');
      INSERT INTO "Term" (id,slug,name,"startDate","endDate") VALUES ('t','legacy','旧学期','2030-01-01','2031-01-01');
      INSERT INTO "CourseOffering" (id,"courseId","termId",title,status) VALUES ('o','c','t','旧开课','ACTIVE');
      INSERT INTO "CourseMember" (id,"offeringId","userId",role) VALUES ('m','o','u','STUDENT');
      INSERT INTO "Assignment" (id,"offeringId",title,description,mode,status) VALUES ('a','o','旧作业','迁移时现有要求','INDIVIDUAL','PUBLISHED');
      INSERT INTO "Submission" (id,"offeringId","assignmentId","courseMemberId") VALUES ('s','o','a','m');
      INSERT INTO "SubmissionVersion" (id,"offeringId","submissionId",version,body,"submittedById") VALUES ('v','o','s',1,'旧提交正文','m');
      INSERT INTO "SubmissionParticipant" ("offeringId","versionId","courseMemberId") VALUES ('o','v','m');
      UPDATE "SubmissionVersion" SET "finalizedAt" = CURRENT_TIMESTAMP WHERE id = 'v';
      INSERT INTO "Resource" (id,"offeringId",title,body,status) VALUES ('r','o','旧资料','正文','PUBLISHED');
      INSERT INTO "CourseFocus" ("offeringId",title,body,"updatedAt") VALUES ('o','旧主页','旧文字','2026-10-01');
    `);
    await client.query(await readFile(path.join(migrations, '20261030000000_record_lifecycle/migration.sql'), 'utf8'));
    const baseline = (await client.query('SELECT * FROM "AssignmentRevision"')).rows[0];
    assert.equal(baseline.isBaseline, true); assert.equal(baseline.actorUserId, null); assert.equal(baseline.description, '迁移时现有要求');
    const legacy = (await client.query('SELECT * FROM "SubmissionVersion"')).rows[0];
    assert.equal(legacy.assignmentRevisionId, null); assert.equal(legacy.body, '旧提交正文');
    assert.equal((await client.query('SELECT "firstPublishedAt" FROM "Resource"')).rows[0].firstPublishedAt, null);
    const focus = (await client.query('SELECT title,"publishedAt","updatedAt","draftDocument" FROM "CourseFocus"')).rows[0];
    assert.equal(focus.title, '旧主页'); assert.equal(focus.draftDocument, null); assert.deepEqual(focus.publishedAt, focus.updatedAt);
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});
