-- Additive migration. Existing observations keep their exact payloads and
-- unknown kinds, lesson contexts, and group contexts.
-- Before the first correction or withdrawal, the previous application can run
-- with the added schema. After revision rows exist, use an application version
-- that applies their effective state or fix forward. A reader that ignores
-- revisions would show superseded or withdrawn content again.
-- Before a schema rollback after new writes, export their new fields and revision rows.
-- Then drop TeachingObservationRevision, drop the three added columns (and
-- their dependent constraints and indexes), drop the two added unique indexes,
-- and finally drop the two enum types. Keep the original immutable triggers.
BEGIN;

CREATE TYPE "TeachingRecordKind" AS ENUM (
  'OBSERVATION', 'PARTICIPATION', 'LEAVE_REPORTED', 'LEAVE_CONFIRMED', 'TEACHING_JUDGMENT'
);
CREATE TYPE "TeachingObservationChange" AS ENUM ('CORRECTED', 'WITHDRAWN');

CREATE UNIQUE INDEX "CourseSubpage_id_offeringId_key" ON "CourseSubpage"("id", "offeringId");
CREATE UNIQUE INDEX "TeachingObservation_id_offeringId_key" ON "TeachingObservation"("id", "offeringId");

ALTER TABLE "TeachingObservation"
  ADD COLUMN "pageId" TEXT,
  ADD COLUMN "contextGroupId" TEXT,
  ADD COLUMN "kind" "TeachingRecordKind",
  ADD CONSTRAINT "TeachingObservation_pageId_offeringId_fkey" FOREIGN KEY ("pageId", "offeringId") REFERENCES "CourseSubpage"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TeachingObservation_contextGroupId_offeringId_fkey" FOREIGN KEY ("contextGroupId", "offeringId") REFERENCES "Group"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TeachingObservation_group_context_subject" CHECK ("contextGroupId" IS NULL OR "targetMemberId" IS NOT NULL),
  ADD CONSTRAINT "TeachingObservation_leave_subject" CHECK ("kind" NOT IN ('LEAVE_REPORTED', 'LEAVE_CONFIRMED') OR "targetMemberId" IS NOT NULL),
  ADD CONSTRAINT "TeachingObservation_confirmation_source" CHECK ("kind" <> 'LEAVE_CONFIRMED' OR btrim("context") <> '');

CREATE INDEX "TeachingObservation_offeringId_pageId_createdAt_idx" ON "TeachingObservation"("offeringId", "pageId", "createdAt");
CREATE INDEX "TeachingObservation_offeringId_contextGroupId_createdAt_idx" ON "TeachingObservation"("offeringId", "contextGroupId", "createdAt");

CREATE TABLE "TeachingObservationRevision" (
  "id" TEXT NOT NULL,
  "offeringId" TEXT NOT NULL,
  "observationId" TEXT NOT NULL,
  "authorUserId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "action" "TeachingObservationChange" NOT NULL,
  "body" TEXT,
  "context" TEXT,
  "observedAt" TIMESTAMP(3),
  "reason" TEXT NOT NULL DEFAULT '',
  "requestId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeachingObservationRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeachingObservationRevision_observationId_offeringId_fkey" FOREIGN KEY ("observationId", "offeringId") REFERENCES "TeachingObservation"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TeachingObservationRevision_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TeachingObservationRevision_payload" CHECK (
    "revision" > 0 AND (
      ("action" = 'CORRECTED' AND "body" IS NOT NULL AND btrim("body") <> '' AND "context" IS NOT NULL)
      OR ("action" = 'WITHDRAWN' AND "body" IS NULL AND "context" IS NULL AND "observedAt" IS NULL AND btrim("reason") <> '')
    )
  )
);

CREATE UNIQUE INDEX "TeachingObservationRevision_requestId_key" ON "TeachingObservationRevision"("requestId");
CREATE UNIQUE INDEX "TeachingObservationRevision_observationId_revision_key" ON "TeachingObservationRevision"("observationId", "revision");
CREATE TRIGGER teaching_observation_revision_immutable BEFORE UPDATE OR DELETE ON "TeachingObservationRevision"
  FOR EACH ROW EXECUTE FUNCTION protect_teaching_observation_history();

COMMIT;
