-- Accept a whole-lesson observation without changing any saved row. The existing
-- composite page foreign key still requires the lesson to be in this offering.
-- Restore the old one-target constraint only before whole-lesson rows exist.
-- After they exist, keep a reader that understands them or fix forward.
BEGIN;

ALTER TABLE "TeachingObservation"
  DROP CONSTRAINT "TeachingObservation_one_target",
  ADD CONSTRAINT "TeachingObservation_valid_subject" CHECK (
    num_nonnulls("targetMemberId", "targetGroupId") = 1
    OR ("targetMemberId" IS NULL AND "targetGroupId" IS NULL AND "pageId" IS NOT NULL AND "versionId" IS NULL)
  );

COMMIT;
