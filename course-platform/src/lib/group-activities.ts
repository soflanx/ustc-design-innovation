import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type TermStatus } from '@prisma/client';
import { z } from 'zod';
import { db } from './db';
import { DomainError } from './management';
import { MAX_SUBMISSION_FILE_BYTES, MAX_SUBMISSION_FILES } from './submission-contract';
import { toTeachingDateInput } from './teaching-format';

const text = (limit: number, label: string) => z.string().trim()
  .max(limit, `${label}请控制在 ${limit} 字以内。`)
  .refine(value => !value.includes('\0'), `${label}含有无效字符。`);

const unsafeFilename = /[/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const upload = z.object({
  name: z.string().trim().min(1).max(255)
    .refine(name => name !== '.' && name !== '..' && name.isWellFormed() && !unsafeFilename.test(name), '附件名称无效。'),
  size: z.number().int().positive(),
  bytes: z.instanceof(Uint8Array),
}).refine(file => file.bytes.length === file.size, '附件读取不完整，请重新选择。');

const activityInput = z.object({
  requestId: z.uuid('保存标识无效，请重新打开表单。'),
  body: text(12000, '工作记录'),
  nextStep: text(1000, '下一步'),
  occurredOn: z.union([z.literal(''), z.iso.date()], { error: '请选择有效的发生日期。' })
    .refine(day => !day.startsWith('0000-'), '请选择有效的发生日期。'),
  participantIds: z.array(z.string().min(1).max(200).refine(id => !id.includes('\0'), '参与者无效，请重新选择。'))
    .refine(ids => new Set(ids).size === ids.length, '参与者名单有重复，请重新选择。'),
  uploads: z.array(upload).max(MAX_SUBMISSION_FILES, '一次最多添加 20 个附件。'),
})
  .refine(data => data.body || data.nextStep || data.uploads.length, '请写下工作内容、下一步，或添加附件。')
  .refine(data => data.uploads.reduce((size, file) => size + file.size, 0) <= MAX_SUBMISSION_FILE_BYTES, '附件合计不能超过 10 MiB。');

type ActivityInput = z.input<typeof activityInput>;
type ActivityReceipt = { id: string; withdrawn?: true };
export type GroupActivityView = {
  id: string;
  body: string;
  nextStep: string;
  occurredOn: Date | null;
  createdAt: Date;
  authorName: string;
  authoredByViewer: boolean;
  participantNames: string[];
  files: { id: string; name: string }[];
};

function visibleActivities(userId: string, offeringId: string, groupId: string): Prisma.GroupActivityWhereInput {
  return {
    offeringId, groupId, withdrawnAt: null,
    group: { offering: { members: { some: {
      userId, status: 'ACTIVE',
      OR: [
        { role: { in: ['TEACHER', 'TA'] } },
        { role: 'STUDENT', groupMemberships: { some: { offeringId, groupId, leftAt: null } } },
      ],
    } } } },
  };
}

export async function getGroupActivities(userId: string, offeringId: string, groupId: string): Promise<GroupActivityView[]> {
  const rows = await db.groupActivity.findMany({
    where: visibleActivities(userId, offeringId, groupId),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true, body: true, nextStep: true, occurredOn: true, createdAt: true,
      author: { select: { user: { select: { id: true, name: true } } } },
      participants: {
        orderBy: [{ courseMember: { user: { name: 'asc' } } }, { courseMemberId: 'asc' }],
        select: { courseMember: { select: { user: { select: { name: true } } } } },
      },
      files: {
        orderBy: { position: 'asc' },
        select: { file: { select: { id: true, originalName: true } } },
      },
    },
  });
  return rows.map(({ author, participants, files, ...activity }) => ({
    ...activity,
    authorName: author.user.name,
    authoredByViewer: author.user.id === userId,
    participantNames: participants.map(entry => entry.courseMember.user.name),
    files: files.map(({ file }) => ({ id: file.id, name: file.originalName })),
  }));
}

async function lockActivityWriters(tx: Prisma.TransactionClient, userId: string, offeringId: string, groupId: string, participantIds: string[] = []) {
  // Archive and group changes must wait until the authorization used here has committed.
  const [offering] = await tx.$queryRaw<{ status: TermStatus }[]>`
    SELECT "status" FROM "CourseOffering" WHERE "id" = ${offeringId} FOR SHARE
  `;
  const selected = participantIds.length ? Prisma.sql`OR cm."id" IN (${Prisma.join(participantIds)})` : Prisma.empty;
  const members = await tx.$queryRaw<{ id: string; userId: string }[]>`
    SELECT cm."id", cm."userId"
    FROM "CourseMember" cm
    JOIN "GroupMember" gm ON gm."courseMemberId" = cm."id" AND gm."offeringId" = cm."offeringId"
    WHERE cm."offeringId" = ${offeringId} AND (cm."userId" = ${userId} ${selected})
      AND cm."status" = 'ACTIVE' AND cm."role" = 'STUDENT'
      AND gm."groupId" = ${groupId} AND gm."leftAt" IS NULL
    ORDER BY cm."id"
    FOR SHARE OF cm, gm
  `;
  const author = members.find(member => member.userId === userId);
  if (!author || !offering) throw new DomainError('只有当前小组的组员可以保存或撤回记录。');
  if (offering.status !== 'ACTIVE') throw new DomainError('课程须在进行中才能保存或撤回小组记录。');
  return { authorId: author.id, memberIds: new Set(members.map(member => member.id)) };
}

export async function saveGroupActivity(userId: string, offeringId: string, groupId: string, input: ActivityInput): Promise<ActivityReceipt> {
  const result = activityInput.safeParse(input);
  if (!result.success) throw new DomainError(result.error.issues[0].message);
  const { requestId, body, nextStep, occurredOn, participantIds, uploads } = result.data;
  if (occurredOn > toTeachingDateInput(new Date()).slice(0, 10)) {
    throw new DomainError('实际发生日期不能晚于北京时间今天。');
  }
  const id = requestId.toLowerCase();
  const requestFingerprint = createHash('sha256').update(JSON.stringify({
    body, nextStep, occurredOn, participantIds: [...participantIds].sort(),
    uploads: uploads.map(file => [file.name, createHash('sha256').update(file.bytes).digest('hex')]),
  })).digest('hex');
  // Read Committed lets the lookup after a skipped insert see the winner.
  return db.$transaction(async tx => {
    const { authorId, memberIds } = await lockActivityWriters(tx, userId, offeringId, groupId, participantIds);
    const { count } = await tx.groupActivity.createMany({
      data: { id, offeringId, groupId, authorId, body, nextStep, requestFingerprint,
        occurredOn: occurredOn ? new Date(`${occurredOn}T00:00:00Z`) : null },
      skipDuplicates: true,
    });
    if (!count) {
      // A simultaneous retry may have just committed while this insert waited.
      const existing = await tx.groupActivity.findFirst({
        where: { id, offeringId, groupId, authorId, requestFingerprint }, select: { withdrawnAt: true },
      });
      if (!existing) throw new DomainError('保存标识已被使用，请重新打开表单。');
      return existing.withdrawnAt ? { id, withdrawn: true } : { id };
    }
    if (participantIds.some(id => !memberIds.has(id))) throw new DomainError('参与者名单已有变化，请重新核对。');
    if (participantIds.length) {
      await tx.groupActivityParticipant.createMany({
        data: participantIds.map(courseMemberId => ({ offeringId, activityId: id, courseMemberId })),
      });
    }
    if (uploads.length) {
      const files = uploads.map(({ name, bytes, size }, position) => ({
        id: randomUUID(), storageKey: randomUUID(), originalName: name, bytes: Uint8Array.from(bytes),
        sizeBytes: size, mimeType: 'application/octet-stream', offeringId, ownerId: userId, position,
      }));
      await tx.fileObject.createMany({ data: files.map(({ position: _position, ...file }) => file) });
      await tx.groupActivityFile.createMany({
        data: files.map(file => ({ offeringId, activityId: id, fileId: file.id, position: file.position })),
      });
    }
    return { id };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function withdrawGroupActivity(userId: string, offeringId: string, groupId: string, activityId: string) {
  await db.$transaction(async tx => {
    const { authorId } = await lockActivityWriters(tx, userId, offeringId, groupId);
    const where = { id: activityId, offeringId, groupId, authorId };
    const { count } = await tx.groupActivity.updateMany({
      where: { ...where, withdrawnAt: null }, data: { withdrawnAt: new Date() },
    });
    if (!count && !await tx.groupActivity.findFirst({ where, select: { id: true } })) {
      throw new DomainError('只有原记录者可以撤回自己的小组记录。');
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function getGroupActivityFile(userId: string, offeringId: string, groupId: string, activityId: string, fileId: string) {
  const file = await db.fileObject.findFirst({
    where: {
      id: fileId, offeringId,
      groupActivities: { some: { offeringId, activityId, activity: visibleActivities(userId, offeringId, groupId) } },
    },
    select: { originalName: true, bytes: true },
  });
  return file?.bytes ? { name: file.originalName, bytes: file.bytes } : null;
}
