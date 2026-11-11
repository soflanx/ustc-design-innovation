import { submissionTextParts } from '@/lib/submission-links';
import { CourseContentIcon } from './course-content-icon';
import styles from './submission-text.module.css';

/** Only the links identified in the readable content can be opened. */
export function LinkedTextParts({ parts }: { parts: readonly { text: string; href?: string }[] }) {
  return <>{parts.map((part, index) => part.href
    ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" className={styles.link}
        title="在新标签页打开" aria-label={`${part.text}（新标签页打开）`}>
        {part.text}<CourseContentIcon name="external" size={13} className={styles.icon}/>
      </a>
    : part.text)}</>;
}

export function SubmissionText({ text }: { text: string }) {
  return <LinkedTextParts parts={submissionTextParts(text)}/>;
}
