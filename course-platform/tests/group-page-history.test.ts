import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { DomainError, GroupPageConflictError, getGroupPageHistory, getGroupPageRevision, moveStudentToGroup, saveGroupPage, setOfferingStatus, type GroupPageContent } from '../src/lib/management';

assert.match(new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/').pathname, /^\/design_test_[a-f\d]+$/);
after(async () => { await db.$disconnect(); });

async function fixture() {
  const key = randomUUID();
  const [teacher, student, peer, ta, admin, outsider] = await Promise.all(['teacher', 'student', 'peer', 'ta', 'admin', 'outsider'].map(name => db.user.create({ data: { email: `${name}-${key}@test.invalid`, name, isAdmin: name === 'admin' } })));
  const course = await db.course.create({ data: { slug: key, title: '小组记录版本测试' } });
  const term = await db.term.create({ data: { slug: key, name: key, startDate: new Date('2030-09-01'), endDate: new Date('2031-01-01') } });
  const offering = await db.courseOffering.create({ data: { courseId: course.id, termId: term.id, title: '隔离测试开课', status: 'ACTIVE' } });
  const members = [];
  for (const [user, role] of [[teacher, 'TEACHER'], [student, 'STUDENT'], [peer, 'STUDENT'], [ta, 'TA']] as const) members.push(await db.courseMember.create({ data: { offeringId: offering.id, userId: user.id, role } }));
  const a = await db.group.create({ data: { offeringId: offering.id, name: 'A组' } });
  const b = await db.group.create({ data: { offeringId: offering.id, name: 'B组' } });
  await db.groupMember.createMany({ data: [members[1], members[2]].map(member => ({ offeringId: offering.id, groupId: a.id, courseMemberId: member.id })) });
  return { teacher, student, peer, ta, admin, outsider, offering, a, b, studentMember: members[1] };
}

const deniedWithoutContent = (promise: Promise<unknown>) => assert.rejects(promise, error => {
  assert.ok(error instanceof DomainError);
  assert.equal(error instanceof GroupPageConflictError, false);
  assert.equal('current' in error, false);
  return true;
});

function oneWinner(results: PromiseSettledResult<GroupPageContent>[]) {
  const wins = results.filter((row): row is PromiseFulfilledResult<GroupPageContent> => row.status === 'fulfilled');
  const losses = results.filter((row): row is PromiseRejectedResult => row.status === 'rejected');
  assert.equal(wins.length, 1); assert.equal(losses.length, 1);
  assert.ok(losses[0].reason instanceof GroupPageConflictError);
  assert.deepEqual(losses[0].reason.current, wins[0].value);
  return wins[0].value;
}

test('小组记录从版本0首次保存，每次保存保留独立快照并最小化历史输出', async () => {
  const f = await fixture();
  assert.deepEqual(await getGroupPageHistory(f.student.id, f.offering.id, f.a.id), []);
  const first = await saveGroupPage(f.student.id, f.offering.id, f.a.id, ' 观察记录 ', ' 访谈发现 ', 0);
  assert.equal(first.revision, 1); assert.equal(first.title, '观察记录'); assert.equal(first.body, '访谈发现');
  const second = await saveGroupPage(f.peer.id, f.offering.id, f.a.id, '设计进展', '整理后的发现', first.revision);
  assert.equal(second.revision, 2);
  const history = await getGroupPageHistory(f.student.id, f.offering.id, f.a.id);
  assert.deepEqual(history.map(row => [row.revision, row.actorName, row.isBaseline]), [[2, 'peer', false], [1, 'student', false]]);
  assert.deepEqual(Object.keys(history[0]).sort(), ['actorName', 'createdAt', 'isBaseline', 'revision', 'title']);
  const old = await getGroupPageRevision(f.student.id, f.offering.id, f.a.id, 1);
  assert.equal(old.body, '访谈发现');
  assert.equal('actorUserId' in old, false); assert.equal('offeringId' in old, false);
  assert.equal(await db.groupPageRevision.count({ where: { groupId: f.a.id } }), 2);
});

test('两人同时首次保存仅一份生效，另一份得到最新正文而不是覆盖', async () => {
  const f = await fixture();
  const winner = oneWinner(await Promise.allSettled([
    saveGroupPage(f.student.id, f.offering.id, f.a.id, '甲的标题', '甲的内容', 0),
    saveGroupPage(f.peer.id, f.offering.id, f.a.id, '乙的标题', '乙的内容', 0),
  ]));
  assert.equal(winner.revision, 1);
  assert.equal(await db.groupPage.count({ where: { groupId: f.a.id } }), 1);
  assert.equal(await db.groupPageRevision.count({ where: { groupId: f.a.id } }), 1);
});

test('同一版本并发编辑仅一份生效，旧表单不得新增历史或改写内容', async () => {
  const f = await fixture();
  await saveGroupPage(f.student.id, f.offering.id, f.a.id, '共同初稿', '共同内容', 0);
  const winner = oneWinner(await Promise.allSettled([
    saveGroupPage(f.student.id, f.offering.id, f.a.id, '甲的修改', '保留甲', 1),
    saveGroupPage(f.peer.id, f.offering.id, f.a.id, '乙的修改', '保留乙', 1),
  ]));
  assert.equal(winner.revision, 2);
  await assert.rejects(saveGroupPage(f.student.id, f.offering.id, f.a.id, '旧表单', '不得写入', 1), error => {
    assert.ok(error instanceof GroupPageConflictError); assert.deepEqual(error.current, winner); return true;
  });
  assert.equal(await db.groupPageRevision.count({ where: { groupId: f.a.id } }), 2);
  assert.equal((await db.groupPage.findUniqueOrThrow({ where: { groupId: f.a.id } })).body, winner.body);
  const merged = await saveGroupPage(f.student.id, f.offering.id, f.a.id, '核对后合并', `${winner.body}\n补充内容`, winner.revision);
  assert.equal(merged.revision, 3);
});

test('读取历史不恢复线上内容，恢复保存形成新版本并仍检查当前版本', async () => {
  const f = await fixture();
  await saveGroupPage(f.student.id, f.offering.id, f.a.id, '早期标题', '早期内容', 0);
  await saveGroupPage(f.peer.id, f.offering.id, f.a.id, '后续标题', '后续内容', 1);
  const toRestore = await getGroupPageRevision(f.student.id, f.offering.id, f.a.id, 1);
  assert.equal((await db.groupPage.findUniqueOrThrow({ where: { groupId: f.a.id } })).body, '后续内容');
  assert.equal(await db.groupPageRevision.count({ where: { groupId: f.a.id } }), 2);
  await saveGroupPage(f.peer.id, f.offering.id, f.a.id, '再次更新', '恢复期间的新内容', 2);
  await assert.rejects(saveGroupPage(f.student.id, f.offering.id, f.a.id, toRestore.title, toRestore.body, 2), GroupPageConflictError);
  const restored = await saveGroupPage(f.student.id, f.offering.id, f.a.id, toRestore.title, toRestore.body, 3);
  assert.equal(restored.revision, 4); assert.equal(restored.body, '早期内容');
  assert.equal((await getGroupPageRevision(f.student.id, f.offering.id, f.a.id, 1)).body, '早期内容');
  assert.equal((await getGroupPageRevision(f.student.id, f.offering.id, f.a.id, 3)).body, '恢复期间的新内容');
});

test('没有修改历史的旧页面首次改动前留存基线，不伪造作者和原保存时间', async () => {
  const f = await fixture();
  await db.groupPage.create({ data: { offeringId: f.offering.id, groupId: f.a.id, title: '旧页面', body: '此前保存的正文', revision: 1, status: 'PUBLISHED' } });
  const started = new Date();
  const saved = await saveGroupPage(f.student.id, f.offering.id, f.a.id, '启用历史后的修改', '新内容', 1);
  assert.equal(saved.revision, 2);
  const baseline = await getGroupPageRevision(f.student.id, f.offering.id, f.a.id, 1);
  assert.equal(baseline.isBaseline, true); assert.equal(baseline.actorName, null); assert.equal(baseline.body, '此前保存的正文');
  assert.ok(new Date(baseline.createdAt).getTime() >= started.getTime());
  assert.equal((await getGroupPageRevision(f.student.id, f.offering.id, f.a.id, 2)).isBaseline, false);
});

test('历史与冲突回执按当前小组授权，不泄露他组、跨期或离组后的正文', async () => {
  const f = await fixture(), other = await fixture();
  await saveGroupPage(f.student.id, f.offering.id, f.a.id, 'A组私有记录', '不应泄露的正文', 0);
  await deniedWithoutContent(getGroupPageHistory(f.outsider.id, f.offering.id, f.a.id));
  await deniedWithoutContent(getGroupPageRevision(f.student.id, f.offering.id, f.b.id, 1));
  await deniedWithoutContent(getGroupPageHistory(f.teacher.id, f.offering.id, other.a.id));
  await deniedWithoutContent(getGroupPageRevision(f.teacher.id, f.offering.id, other.a.id, 1));
  await deniedWithoutContent(saveGroupPage(f.admin.id, f.offering.id, other.a.id, '越期', '越期内容', 0));
  await moveStudentToGroup(f.teacher.id, f.offering.id, f.b.id, f.studentMember.id);
  await deniedWithoutContent(getGroupPageHistory(f.student.id, f.offering.id, f.a.id));
  await deniedWithoutContent(getGroupPageRevision(f.student.id, f.offering.id, f.a.id, 1));
  await deniedWithoutContent(saveGroupPage(f.student.id, f.offering.id, f.a.id, '旧页面修改', '本地旧稿', 0));
  assert.deepEqual(await getGroupPageHistory(f.student.id, f.offering.id, f.b.id), []);
  await db.courseMember.update({ where: { id: f.studentMember.id }, data: { status: 'INACTIVE' } });
  await deniedWithoutContent(getGroupPageHistory(f.student.id, f.offering.id, f.b.id));
  await deniedWithoutContent(saveGroupPage(f.student.id, f.offering.id, f.b.id, '停用', '停用后写入', 0));
});

test('教师与助教只读历史，管理员可编辑；归档后所有角色只读', async () => {
  const f = await fixture();
  await saveGroupPage(f.student.id, f.offering.id, f.a.id, '小组进展', '保留内容', 0);
  for (const actor of [f.teacher, f.ta]) {
    assert.equal((await getGroupPageRevision(actor.id, f.offering.id, f.a.id, 1)).body, '保留内容');
    await deniedWithoutContent(saveGroupPage(actor.id, f.offering.id, f.a.id, '代写', '代写正文', 1));
  }
  await saveGroupPage(f.admin.id, f.offering.id, f.a.id, '管理员修正', '修正后的内容', 1);
  await setOfferingStatus(f.teacher.id, f.offering.id, 'ARCHIVED');
  for (const actor of [f.student, f.peer, f.teacher, f.ta, f.admin]) {
    assert.equal((await getGroupPageHistory(actor.id, f.offering.id, f.a.id)).length, 2);
    assert.equal((await getGroupPageRevision(actor.id, f.offering.id, f.a.id, 1)).body, '保留内容');
    await deniedWithoutContent(saveGroupPage(actor.id, f.offering.id, f.a.id, '归档后修改', '不应保存', 2));
  }
  assert.equal(await db.groupPageRevision.count({ where: { groupId: f.a.id } }), 2);
});

test('缺少版本与非法版本不能绕过检查，数据库拒绝改写或删除历史快照', async () => {
  const f = await fixture();
  for (const revision of [undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) await deniedWithoutContent(saveGroupPage(f.student.id, f.offering.id, f.a.id, '标题', '正文', revision as number));
  assert.equal(await db.groupPage.count({ where: { groupId: f.a.id } }), 0);
  await saveGroupPage(f.student.id, f.offering.id, f.a.id, '已保存标题', '不可变正文', 0);
  await assert.rejects(db.groupPageRevision.updateMany({ where: { groupId: f.a.id, revision: 1 }, data: { body: '篡改历史' } }));
  await assert.rejects(db.groupPageRevision.deleteMany({ where: { groupId: f.a.id, revision: 1 } }));
  assert.equal((await getGroupPageRevision(f.student.id, f.offering.id, f.a.id, 1)).body, '不可变正文');
});
