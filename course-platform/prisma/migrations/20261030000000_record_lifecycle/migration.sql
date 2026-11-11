CREATE TYPE "AssignmentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED', 'CANCELLED');
ALTER TABLE "Assignment" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Assignment" ALTER COLUMN "status" TYPE "AssignmentStatus" USING ("status"::text::"AssignmentStatus");
ALTER TABLE "Assignment" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
ALTER TABLE "Assignment"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "cancellationReason" TEXT,
  ADD COLUMN "creationRequestId" TEXT,
  ADD COLUMN "creationFingerprint" TEXT,
  ADD COLUMN "creatorId" TEXT;
CREATE UNIQUE INDEX "Assignment_creationRequestId_key" ON "Assignment"("creationRequestId");
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_revision_positive" CHECK ("revision" > 0);
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_cancellation_reason" CHECK (
  ("status" = 'CANCELLED' AND "cancellationReason" IS NOT NULL AND length(btrim("cancellationReason")) BETWEEN 1 AND 2000)
  OR ("status" <> 'CANCELLED' AND "cancellationReason" IS NULL)
);

CREATE TABLE "AssignmentRevision" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "offeringId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "mode" "AssignmentMode" NOT NULL,
  "dueAt" TIMESTAMP(3),
  "maxScore" DECIMAL(8,2) NOT NULL,
  "status" "AssignmentStatus" NOT NULL,
  "cancellationReason" TEXT,
  "actorUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "isBaseline" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "AssignmentRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssignmentRevision_revision_positive" CHECK ("revision" > 0)
);
CREATE UNIQUE INDEX "AssignmentRevision_assignmentId_revision_key" ON "AssignmentRevision"("assignmentId", "revision");
CREATE UNIQUE INDEX "AssignmentRevision_id_offeringId_key" ON "AssignmentRevision"("id", "offeringId");
CREATE INDEX "AssignmentRevision_assignmentId_createdAt_idx" ON "AssignmentRevision"("assignmentId", "createdAt");
ALTER TABLE "AssignmentRevision" ADD CONSTRAINT "AssignmentRevision_assignmentId_offeringId_fkey" FOREIGN KEY ("assignmentId", "offeringId") REFERENCES "Assignment"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssignmentRevision" ADD CONSTRAINT "AssignmentRevision_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- This is a snapshot observed during migration, never a reconstruction of past requirements.
INSERT INTO "AssignmentRevision" ("id", "assignmentId", "offeringId", "revision", "title", "description", "mode", "dueAt", "maxScore", "status", "isBaseline")
SELECT 'baseline-' || "id", "id", "offeringId", "revision", "title", "description", "mode", "dueAt", "maxScore", "status", true FROM "Assignment";

ALTER TABLE "SubmissionVersion" ADD COLUMN "assignmentRevisionId" TEXT;
-- Old submissions intentionally stay NULL: the requirements they saw are unknown.
ALTER TABLE "SubmissionVersion" ADD CONSTRAINT "SubmissionVersion_assignmentRevisionId_offeringId_fkey" FOREIGN KEY ("assignmentRevisionId", "offeringId") REFERENCES "AssignmentRevision"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE FUNCTION guard_assignment_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Assignment requirement revisions are immutable';
END; $$;
CREATE TRIGGER assignment_revision_immutable BEFORE UPDATE OR DELETE ON "AssignmentRevision" FOR EACH ROW EXECUTE FUNCTION guard_assignment_revision_mutation();
CREATE FUNCTION validate_submission_assignment_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."assignmentRevisionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "AssignmentRevision" r JOIN "Submission" s ON s."assignmentId" = r."assignmentId" AND s."offeringId" = r."offeringId"
    WHERE r."id" = NEW."assignmentRevisionId" AND s."id" = NEW."submissionId" AND r."status" = 'PUBLISHED'
  ) THEN RAISE EXCEPTION 'Submission requirement revision must belong to its published assignment'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER submission_assignment_revision_valid BEFORE INSERT OR UPDATE ON "SubmissionVersion" FOR EACH ROW EXECUTE FUNCTION validate_submission_assignment_revision();

ALTER TABLE "Resource"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "firstPublishedAt" TIMESTAMP(3),
  ADD COLUMN "creationRequestId" TEXT,
  ADD COLUMN "creationFingerprint" TEXT,
  ADD COLUMN "creatorId" TEXT;
-- NULL on migrated resources means publication history was not tracked; it does not prove never published.
CREATE UNIQUE INDEX "Resource_creationRequestId_key" ON "Resource"("creationRequestId");
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_revision_positive" CHECK ("revision" > 0);

ALTER TABLE "CourseFocus"
  ADD COLUMN "draftDocument" JSONB,
  ADD COLUMN "draftTitle" TEXT,
  ADD COLUMN "draftSavedAt" TIMESTAMP(3),
  ADD COLUMN "publishedAt" TIMESTAMP(3);
-- Existing document/title stay the published page. New drafts are saved separately.
UPDATE "CourseFocus" SET "publishedAt" = "updatedAt";
