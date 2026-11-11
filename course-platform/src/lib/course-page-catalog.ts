import { db } from './db';
import { groupWorkHref } from './group-work-link';
import { getAssignmentIndex } from './teaching';
import { getCourseResources } from './resource-service';
import type { CourseDocumentCatalog } from './course-document-view';
import { assignmentCatalogRecord, resourceCatalogRecord } from './course-record-catalog';
import type { CourseMember, TermStatus } from '@prisma/client';

export async function loadCoursePageCatalog(user: { id: string; isAdmin: boolean }, offering: { id: string; status: TermStatus }, membership: CourseMember | null, sourcePageId?: string) {
  const student = !user.isAdmin && membership?.role === 'STUDENT';
  const [teaching, materials, groups] = await Promise.all([
    getAssignmentIndex(user.id, offering.id),
    getCourseResources(user.id, offering.id),
    db.group.findMany({
      where: { offeringId: offering.id, ...(student ? { members: { some: { courseMemberId: membership!.id, leftAt: null } } } : {}) },
      orderBy: { name: 'asc' },
      include: {
        page: { select: { title: true } },
        members: { where: { leftAt: null, courseMember: { status: 'ACTIVE' } }, select: { id: true } },
        taAssignments: { where: { endedAt: null, courseMember: { status: 'ACTIVE' } }, select: { courseMember: { select: { user: { select: { name: true } } } } } },
      },
    }),
  ]);
  const canManageRecords = teaching.canManage;
  const catalog: CourseDocumentCatalog = {
    assignments: teaching.assignments.map(assignment => assignmentCatalogRecord(assignment, {
      audience: user.isAdmin ? 'ADMIN' : membership!.role, offeringStatus: offering.status, canManageRecords, sourcePageId,
    })),
    resources: materials.resources.map(resource => resourceCatalogRecord(resource, canManageRecords)),
    groups: groups.map(group => ({
      id: group.id, title: group.page?.title || group.name, href: groupWorkHref(offering.id, sourcePageId, group.id), actionLabel: '进入小组',
      subtitle: `${group.name} · ${group.members.length} 位组员`,
      detail: `负责助教：${group.taAssignments.map(item => item.courseMember.user.name).join('、') || '待分配'}`,
    })),
  };
  // For older text-only records, the body is the downloadable file itself.
  const readingNotes = new Map<string, string>();
  if (student) {
    for (const resource of materials.resources) {
      if ((resource.file || resource.url) && resource.body.trim()) readingNotes.set(resource.id, resource.body);
    }
  }
  return { catalog, teaching, readingNotes };
}
