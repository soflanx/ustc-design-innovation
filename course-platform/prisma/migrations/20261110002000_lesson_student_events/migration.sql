-- Add an explicit classroom observation kind without rewriting historical rows.
-- After an ABSENT row exists, keep a reader that understands the new kind.
ALTER TYPE "TeachingRecordKind" ADD VALUE 'ABSENT';
