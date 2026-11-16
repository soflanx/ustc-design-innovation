import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { getGroupActivities, getGroupActivityFile, saveGroupActivity, withdrawGroupActivity } from '../src/lib/group-activities';
import { DomainError, moveStudentToGroup, setOfferingStatus } from '../src/lib/management';
import { MAX_SUBMISSION_FILE_BYTES } from '../src/lib/submission-contract';
import { toTeachingDateInput } from '../src/lib/teaching-format';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(async () => { await db.$disconnect(); });

async function fixture() {
  const key = randomUUID();
  const joinedAt = new Date('2024-09-01T00:00:00+08:00');
  const course = await db.course.create({ data: { slug: key, title: '小组工作记录测试' } });
  const term = await db.term.create({ data: {
    slug: key, name: '隔离测试学期', startDate: joinedAt, endDate: new Date('2025-01-20'),
  } });
  const offering = await db.courseOffering.create({ data: { courseId: course.id, termId: term.id, title: '隔离测试课堂', status: 'ACTIVE' } });
  const user = (name: string, isAdmin = false) => db.user.create({ data: { email: `${randomUUID()}@test.invalid`, name, isAdmin } });
  const [author, peer, otherStudent, teacher, ta, admin, outsider] = await Promise.all([
    user('记录人'), user('参与者'), user('第二组学生'), user('教师'), user('助教'), user('管理员', true), user('未入课学生'),
  ]);
  const [authorMember, peerMember, otherMember] = await Promise.all(([
    [author, 'STUDENT'], [peer, 'STUDENT'], [otherStudent, 'STUDENT'], [teacher, 'TEACHER'], [ta, 'TA'],
  ] as const).map(([person, role]) => db.courseMember.create({
    data: { offeringId: offering.id, userId: person.id, role, joinedAt },
  })));
  const [group, otherGroup] = await Promise.all(['第一组', '第二组'].map(name => db.group.create({ data: { offeringId: offering.id, name } })));
  await db.groupMember.createMany({ data: [
    { courseMemberId: authorMember.id, groupId: group.id },
    { courseMemberId: peerMember.id, groupId: group.id },
    { courseMemberId: otherMember.id, groupId: otherGroup.id },
  ].map(membership => ({ ...membership, offeringId: offering.id, joinedAt })) });
  return { offering, group, otherGroup, author, peer, otherStudent, teacher, ta, admin, outsider, authorMember, peerMember, otherMember };
}

type ActivityInput = Parameters<typeof saveGroupActivity>[3];

function activity(fields: Partial<ActivityInput> = {}): ActivityInput {
  return { requestId: randomUUID(), body: '第一版座椅原型留出的通道偏窄。', nextStep: '', occurredOn: '', participantIds: [], uploads: [], ...fields };
}

function material(name: string, contents: string) {
  const bytes = new TextEncoder().encode(contents);
  return { name, size: bytes.length, bytes };
}

test('组员和教学团队能接续同一份工作，调组只影响阅读范围', async () => {
  const f = await fixture();
  const { id: offeringId } = f.offering;
  const { id: groupId } = f.group;
  const upload = material('原型测试.txt', '入口净宽：85 厘米');
  const input = activity({ nextStep: '下次在午间再测一次。', occurredOn: '2024-10-21', participantIds: [f.peerMember.id], uploads: [upload] });
  const { id } = await saveGroupActivity(f.author.id, offeringId, groupId, input);
  const [record] = await getGroupActivities(f.author.id, offeringId, groupId);
  assert.ok(record.occurredOn);
  assert.equal(toTeachingDateInput(record.occurredOn).slice(0, 10), input.occurredOn);
  assert.ok(record.createdAt instanceof Date);
  assert.equal(record.body, input.body);
  assert.equal(record.nextStep, input.nextStep);
  assert.equal(record.authorName, f.author.name);
  assert.deepEqual(record.participantNames, [f.peer.name]);
  assert.equal(record.authoredByViewer, true);
  const [file] = record.files;
  assert.equal(file.name, upload.name);

  for (const reader of [f.peer, f.teacher, f.ta]) {
    const [shared] = await getGroupActivities(reader.id, offeringId, groupId);
    assert.equal(shared.id, id);
    assert.equal(shared.authoredByViewer, false);
    const attachment = await getGroupActivityFile(reader.id, offeringId, groupId, id, file.id);
    assert.ok(attachment);
    assert.equal(attachment.name, upload.name);
    assert.deepEqual(new Uint8Array(attachment.bytes), upload.bytes);
  }
  for (const other of [f.otherStudent, f.outsider, f.admin]) {
    assert.deepEqual(await getGroupActivities(other.id, offeringId, groupId), []);
    assert.equal(await getGroupActivityFile(other.id, offeringId, groupId, id, file.id), null);
  }
  for (const other of [f.otherStudent, f.teacher, f.ta, f.admin]) {
    await assert.rejects(saveGroupActivity(other.id, offeringId, groupId, activity()), DomainError);
  }

  await moveStudentToGroup(f.teacher.id, offeringId, groupId, f.otherMember.id);
  await moveStudentToGroup(f.teacher.id, offeringId, f.otherGroup.id, f.authorMember.id);
  const [previous] = await getGroupActivities(f.otherStudent.id, offeringId, groupId);
  assert.equal(previous.id, id);
  assert.deepEqual(previous.participantNames, [f.peer.name]);
  assert.ok(await getGroupActivityFile(f.otherStudent.id, offeringId, groupId, id, file.id));
  assert.deepEqual(await getGroupActivities(f.author.id, offeringId, groupId), []);
  assert.equal(await getGroupActivityFile(f.author.id, offeringId, groupId, id, file.id), null);
  await assert.rejects(saveGroupActivity(f.author.id, offeringId, groupId, activity()), DomainError);
  await assert.rejects(withdrawGroupActivity(f.author.id, offeringId, groupId, id), DomainError);
});

test('同一条带附件的记录并行重试只保存一次，附件必须属于地址中的活动', async () => {
  const f = await fixture();
  const { id: offeringId } = f.offering;
  const { id: groupId } = f.group;
  const upload = material('访谈摘录.txt', '使用者常在门边等候。');
  const input = activity({ body: '', uploads: [upload] });
  const save = () => saveGroupActivity(f.author.id, offeringId, groupId, input);
  const [first, second] = await Promise.all([save(), save()]);
  assert.equal(second.id, first.id);
  assert.equal((await save()).id, first.id);
  const records = await getGroupActivities(f.peer.id, offeringId, groupId);
  assert.deepEqual(records.map(record => record.id), [first.id]);
  assert.deepEqual(records[0].files.map(file => file.name), [upload.name]);
  assert.deepEqual(records[0].participantNames, []);
  assert.equal(records[0].occurredOn, null);
  const [file] = records[0].files;
  const next = await saveGroupActivity(f.peer.id, offeringId, groupId, activity({ body: '', nextStep: '带原型到午间现场。' }));
  assert.ok(await getGroupActivityFile(f.peer.id, offeringId, groupId, first.id, file.id));
  assert.equal(await getGroupActivityFile(f.peer.id, offeringId, groupId, next.id, file.id), null);
  assert.equal(await getGroupActivityFile(f.teacher.id, offeringId, f.otherGroup.id, first.id, file.id), null);
  assert.equal(await getGroupActivityFile(f.teacher.id, randomUUID(), groupId, first.id, file.id), null);
});

test('两位组员同时保存各自活动并记录对方参与时，两条都能找回', async () => {
  const f = await fixture();
  const { id: offeringId } = f.offering;
  const { id: groupId } = f.group;
  const [first, second] = await Promise.all([
    saveGroupActivity(f.author.id, offeringId, groupId, activity({ participantIds: [f.peerMember.id] })),
    saveGroupActivity(f.peer.id, offeringId, groupId, activity({ body: '重新测量两个入口。', participantIds: [f.authorMember.id] })),
  ]);
  const records = await getGroupActivities(f.ta.id, offeringId, groupId);
  assert.equal(records.length, 2);
  assert.deepEqual(records.find(record => record.id === first.id)?.participantNames, [f.peer.name]);
  assert.deepEqual(records.find(record => record.id === second.id)?.participantNames, [f.author.name]);
});

test('活动附件按选择顺序读取并限制文件名和合计大小', async () => {
  const f = await fixture();
  const save = (uploads: ActivityInput['uploads']) => saveGroupActivity(f.author.id, f.offering.id, f.group.id, activity({ uploads }));
  const large = new Uint8Array(MAX_SUBMISSION_FILE_BYTES / 2 + 1);
  for (const invalid of [
    [material('../原型.txt', '上级路径')],
    [material('访谈\0摘录.txt', '无效名称')],
    [{ name: '测试一.bin', size: large.length, bytes: large }, { name: '测试二.bin', size: large.length, bytes: large }],
  ]) {
    await assert.rejects(save(invalid), DomainError);
  }
  assert.deepEqual(await getGroupActivities(f.peer.id, f.offering.id, f.group.id), []);

  const uploads = [material('2-先看原型.txt', '第一份'), material('1-再看测量.txt', '第二份')];
  const { id } = await save(uploads);
  const [record] = await getGroupActivities(f.peer.id, f.offering.id, f.group.id);
  assert.equal(record.id, id);
  assert.deepEqual(record.files.map(file => file.name), uploads.map(file => file.name));
  const secondFile = await getGroupActivityFile(f.peer.id, f.offering.id, f.group.id, id, record.files[1].id);
  assert.ok(secondFile);
  assert.deepEqual(new Uint8Array(secondFile.bytes), uploads[1].bytes);
});

test('记录人撤下后停止提供正文和附件，归档后仍可读取现有材料', async () => {
  const f = await fixture();
  const { id: offeringId } = f.offering;
  const { id: groupId } = f.group;
  const input = activity({ uploads: [material('旧图说明.txt', '这份材料需撤下。')] });
  const { id } = await saveGroupActivity(f.author.id, offeringId, groupId, input);
  const [record] = await getGroupActivities(f.author.id, offeringId, groupId);
  const [file] = record.files;
  await assert.rejects(withdrawGroupActivity(f.peer.id, offeringId, groupId, id), DomainError);
  await withdrawGroupActivity(f.author.id, offeringId, groupId, id);
  await withdrawGroupActivity(f.author.id, offeringId, groupId, id);
  assert.equal((await saveGroupActivity(f.author.id, offeringId, groupId, input)).id, id);
  assert.deepEqual(await getGroupActivities(f.peer.id, offeringId, groupId), []);
  assert.equal(await getGroupActivityFile(f.ta.id, offeringId, groupId, id, file.id), null);

  const saved = await saveGroupActivity(f.author.id, offeringId, groupId, activity({ uploads: [material('保留.txt', '期末回看材料。')] }));
  const [retained] = await getGroupActivities(f.author.id, offeringId, groupId);
  const [retainedFile] = retained.files;
  await setOfferingStatus(f.teacher.id, offeringId, 'ARCHIVED');
  assert.deepEqual((await getGroupActivities(f.peer.id, offeringId, groupId)).map(record => record.id), [saved.id]);
  assert.ok(await getGroupActivityFile(f.ta.id, offeringId, groupId, saved.id, retainedFile.id));
  await assert.rejects(saveGroupActivity(f.author.id, offeringId, groupId, activity()), DomainError);
  await assert.rejects(withdrawGroupActivity(f.author.id, offeringId, groupId, saved.id), DomainError);
  assert.equal((await getGroupActivities(f.ta.id, offeringId, groupId))[0].id, saved.id);
});

test('空白活动、无法成立的日期与其他组参与人均不得保存', async () => {
  const f = await fixture();
  const { id: offeringId } = f.offering;
  const { id: groupId } = f.group;
  for (const invalid of [
    activity({ body: '   ' }),
    activity({ occurredOn: '2024-02-30' }),
    activity({ participantIds: [f.otherMember.id] }),
  ]) {
    await assert.rejects(saveGroupActivity(f.author.id, offeringId, groupId, invalid), DomainError);
  }
  assert.deepEqual(await getGroupActivities(f.author.id, offeringId, groupId), []);
});
