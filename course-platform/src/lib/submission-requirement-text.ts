import { splitAssignmentMaterialLinks } from './assignment-material-links';
import type { SubmissionRequirements } from './submission-contract';
import { submissionTextParts } from './submission-links';

/** The confirmation panel carries material labels, never the protected resource targets. */
export function submissionRequirementText(source: string, offeringId: string): Pick<SubmissionRequirements, 'description' | 'descriptionParts'> {
  const descriptionParts = splitAssignmentMaterialLinks(source, offeringId).flatMap(part =>
    part.resourceId ? [{ text: part.text }] : submissionTextParts(part.text));
  const description = descriptionParts.map(part => part.text).join('');
  return descriptionParts.some(part => part.href) ? { description, descriptionParts } : { description };
}
