import type { ReactNode } from 'react';
import { splitAssignmentMaterialLinks } from '@/lib/assignment-material-links';
import { resourceReference } from '@/lib/course-record-catalog';
import { getCourseResourceReferences } from '@/lib/resource-service';
import { SubmissionText } from './submission-text';

/** Resolve material access once for the current requirements and every readable snapshot. */
export async function readAssignmentRequirements(userId: string, offeringId: string, descriptions: string[]) {
  const parsed = new Map<string, ReturnType<typeof splitAssignmentMaterialLinks>>();
  const resourceIds = new Set<string>();
  for (const description of new Set(descriptions)) {
    if (!description) continue;
    const parts = splitAssignmentMaterialLinks(description, offeringId);
    parsed.set(description, parts);
    for (const part of parts) {
      if (part.resourceId) resourceIds.add(part.resourceId);
    }
  }
  const resources = resourceIds.size ? await getCourseResourceReferences(userId, offeringId, [...resourceIds]) : [];
  const references = new Map(resources.map(resource => [resource.id, resourceReference(resource)]));
  const bodies = new Map<string, ReactNode>();
  for (const [description, parts] of parsed) {
    bodies.set(description, parts.map((part, index) => {
      if (!part.resourceId) return <SubmissionText key={index} text={part.text}/>;
      const reference = references.get(part.resourceId);
      if (!reference) return part.text;
      const { href, actionLabel, opensInNewTab } = reference;
      const action = opensInNewTab ? `${actionLabel}（新标签页）` : actionLabel;
      return <a key={index} href={href} target={opensInNewTab ? '_blank' : undefined}
        rel={opensInNewTab ? 'noopener noreferrer' : undefined} title={action} aria-label={`${part.text}，${action}`}>{part.text}</a>;
    }));
  }
  return bodies;
}
