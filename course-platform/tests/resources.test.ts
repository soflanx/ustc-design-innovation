import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { DomainError } from '../src/lib/management';
import { changeResourceStatus, createResource, getCourseResource, getCourseResourceFile, getCourseResources, updateResource } from '../src/lib/resource-service';
import { MAX_RESOURCE_FILE_BYTES } from '../src/lib/resource-file-limits';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(async () => { await db.$disconnect(); });

async function fixture() {
  const key = randomUUID();
  const users = await Promise.all(['teacher', 'ta', 'student', 'outsider', 'admin'].map(name =>
    db.user.create({ data: { email: `${name}-${key}@test.invalid`, name, isAdmin: name === 'admin' } })));
  const [teacher, ta, student, outsider, admin] = users;
  const course = await db.course.create({ data: { title: '资料测试课', slug: key } });
  const term = await db.term.create({ data: { slug: key, name: '资料测试学期', startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } });
  const offering = await db.courseOffering.create({ data: { courseId: course.id, termId: term.id, title: '资料测试开课', status: 'ACTIVE' } });
  for (const [user, role] of [[teacher, 'TEACHER'], [ta, 'TA'], [student, 'STUDENT']] as const) {
    await db.courseMember.create({ data: { offeringId: offering.id, userId: user.id, role } });
  }
  return { teacher, ta, student, outsider, admin, offering };
}

const draft = { title: '访谈记录模板', body: '请记录观察与证据。', url: '', status: 'DRAFT' as const };
const denied = (promise: Promise<unknown>) => assert.rejects(promise, DomainError);

test('资料草稿和下架内容仅教师/管理员可读，发布后课程成员可见', async () => {
  const f = await fixture();
  const resource = await createResource(f.teacher.id, f.offering.id, draft);
  for (const actor of [f.student, f.ta]) {
    assert.equal((await getCourseResources(actor.id, f.offering.id)).resources.length, 0);
    assert.equal((await getCourseResource(actor.id, f.offering.id, resource.id)).resource, null);
  }
  assert.equal((await getCourseResources(f.admin.id, f.offering.id)).resources.length, 1);
  const published = await updateResource(f.teacher.id, f.offering.id, resource.id, { ...draft, status: 'PUBLISHED' }, resource.revision);
  assert.equal((await getCourseResource(f.student.id, f.offering.id, resource.id)).resource?.body, draft.body);
  await updateResource(f.teacher.id, f.offering.id, resource.id, { ...draft, status: 'ARCHIVED' }, published.revision);
  assert.equal((await getCourseResources(f.student.id, f.offering.id)).resources.length, 0);
  assert.equal((await getCourseResource(f.teacher.id, f.offering.id, resource.id)).resource?.status, 'ARCHIVED');
});

test('资料服务独立鉴权，拒绝学生/助教写入、外部用户读取及跨期ID', async () => {
  const f = await fixture();
  const other = await fixture();
  const resource = await createResource(f.teacher.id, f.offering.id, { ...draft, status: 'PUBLISHED' });
  for (const actor of [f.student, f.ta, f.outsider]) {
    await denied(createResource(actor.id, f.offering.id, draft));
    await denied(updateResource(actor.id, f.offering.id, resource.id, draft, resource.revision));
  }
  await denied(getCourseResources(f.outsider.id, f.offering.id));
  await denied(getCourseResource(f.outsider.id, f.offering.id, resource.id));
  assert.equal((await getCourseResource(other.teacher.id, other.offering.id, resource.id)).resource, null);
  await denied(updateResource(other.teacher.id, other.offering.id, resource.id, draft, resource.revision));
  await db.courseMember.update({ where: { offeringId_userId: { offeringId: f.offering.id, userId: f.student.id } }, data: { status: 'INACTIVE' } });
  await denied(getCourseResources(f.student.id, f.offering.id));
  assert.equal((await db.resource.findUniqueOrThrow({ where: { id: resource.id } })).status, 'PUBLISHED');
});

test('资料链接与长度在服务层验证，归档开课所有写入只读', async () => {
  const f = await fixture();
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', 'https://name:secret@example.invalid', 'not-a-link']) {
    await assert.rejects(createResource(f.teacher.id, f.offering.id, { ...draft, url }));
  }
  await assert.rejects(createResource(f.teacher.id, f.offering.id, { ...draft, body: '', url: '' }));
  await assert.rejects(createResource(f.teacher.id, f.offering.id, { ...draft, body: 'a'.repeat(12001) }));
  const resource = await createResource(f.admin.id, f.offering.id, { ...draft, status: 'PUBLISHED', url: 'https://example.invalid/materials' });
  assert.equal(resource.visibility, 'OFFERING');
  await db.courseOffering.update({ where: { id: f.offering.id }, data: { status: 'ARCHIVED' } });
  for (const actor of [f.teacher, f.admin]) {
    await denied(createResource(actor.id, f.offering.id, draft));
    await denied(updateResource(actor.id, f.offering.id, resource.id, draft, resource.revision));
  }
  assert.equal((await getCourseResource(f.student.id, f.offering.id, resource.id)).resource?.body, draft.body);
});

test('目录只返回附件元数据，下载按本期角色和最新发布状态读取原始字节', async () => {
  const f = await fixture();
  const other = await fixture();
  const bytes = new Uint8Array([0, 255, 42]);
  const name = '测试记录.xlsx';
  const uploaded = await createResource(f.teacher.id, f.offering.id, { ...draft, body: '', file: new File([bytes], name) });
  assert.deepEqual(uploaded.file, { name, size: 3 });
  assert.deepEqual((await getCourseResources(f.teacher.id, f.offering.id)).resources[0].file, { name, size: 3 });
  assert.equal(await getCourseResourceFile(f.student.id, f.offering.id, uploaded.id), null);
  const published = await changeResourceStatus(f.teacher.id, f.offering.id, uploaded.id, { status: 'PUBLISHED', expectedRevision: uploaded.revision });
  for (const actor of [f.student, f.ta, f.teacher]) {
    const file = await getCourseResourceFile(actor.id, f.offering.id, uploaded.id);
    assert.ok(file && 'bytes' in file);
    assert.equal(file.name, name);
    assert.deepEqual([...file.bytes], [...bytes]);
  }
  await denied(getCourseResourceFile(f.outsider.id, f.offering.id, uploaded.id));
  assert.equal(await getCourseResourceFile(other.teacher.id, other.offering.id, uploaded.id), null);
  await changeResourceStatus(f.teacher.id, f.offering.id, uploaded.id, { status: 'ARCHIVED', expectedRevision: published.revision });
  assert.equal(await getCourseResourceFile(f.ta.id, f.offering.id, uploaded.id), null);
});

test('附件重试核对文件字节，带版本的更新可在附件和外链之间切换', async () => {
  const f = await fixture();
  const requestId = randomUUID();
  const firstFile = new File(['123'], '测试资料.txt');
  const input = { ...draft, file: firstFile, body: '' };
  const create = () => createResource(f.teacher.id, f.offering.id, input, requestId);
  const [first, retried] = await Promise.all([create(), create()]);
  assert.equal(first.id, retried.id);
  await denied(createResource(f.teacher.id, f.offering.id, { ...input, file: new File(['132'], firstFile.name) }, requestId));
  const edits = await updateResource(f.teacher.id, f.offering.id, first.id, { ...draft, body: '', title: '新标题' }, first.revision);
  assert.deepEqual(edits.file, first.file);
  const url = 'https://example.invalid/slides';
  const linked = await updateResource(f.teacher.id, f.offering.id, first.id, { ...draft, url }, edits.revision);
  assert.equal(linked.file, null);
  assert.deepEqual(await getCourseResourceFile(f.teacher.id, f.offering.id, first.id), { url });
  await denied(updateResource(f.teacher.id, f.offering.id, first.id, input, edits.revision));
  const replaced = await updateResource(f.teacher.id, f.offering.id, first.id, { ...draft, file: new File(['changed'], firstFile.name), url }, linked.revision);
  assert.equal(replaced.url, null);
  const downloaded = await getCourseResourceFile(f.teacher.id, f.offering.id, first.id);
  assert.ok(downloaded && 'bytes' in downloaded);
  assert.equal(new TextDecoder().decode(downloaded.bytes), 'changed');
});

test('超限上传不会创建记录，旧文字资料以原正文下载', async () => {
  const f = await fixture();
  await denied(createResource(f.teacher.id, f.offering.id, { ...draft, file: new File([new Uint8Array(MAX_RESOURCE_FILE_BYTES + 1)], '讲义.pdf') }));
  assert.equal((await getCourseResources(f.teacher.id, f.offering.id)).resources.length, 0);
  const legacy = await createResource(f.teacher.id, f.offering.id, { ...draft, status: 'PUBLISHED' });
  const result = await getCourseResourceFile(f.student.id, f.offering.id, legacy.id);
  assert.ok(result && 'bytes' in result);
  assert.equal(result.name, draft.title + '.txt');
  assert.equal(new TextDecoder().decode(result.bytes), draft.body);
});
