-- Review completion is independent of comments and sealed submission contents.
CREATE TYPE "SubmissionReviewStatus" AS ENUM ('PENDING', 'COMPLETED', 'LEGACY_UNKNOWN');

CREATE TABLE "SubmissionVersionReview" (
  "versionId" TEXT NOT NULL,
  "offeringId" TEXT NOT NULL,
  "state" "SubmissionReviewStatus" NOT NULL DEFAULT 'PENDING',
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "updatedById" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubmissionVersionReview_pkey" PRIMARY KEY ("versionId"),
  CONSTRAINT "SubmissionVersionReview_versionId_offeringId_fkey" FOREIGN KEY ("versionId", "offeringId") REFERENCES "SubmissionVersion"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SubmissionVersionReview_updatedById_offeringId_fkey" FOREIGN KEY ("updatedById", "offeringId") REFERENCES "CourseMember"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SubmissionVersionReview_versionId_offeringId_key" ON "SubmissionVersionReview"("versionId", "offeringId");

CREATE TABLE "SubmissionReviewEvent" (
  "id" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "offeringId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL CHECK ("revision" > 0),
  "state" "SubmissionReviewStatus" NOT NULL,
  "actorId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "isBaseline" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "SubmissionReviewEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SubmissionReviewEvent_versionId_offeringId_fkey" FOREIGN KEY ("versionId", "offeringId") REFERENCES "SubmissionVersionReview"("versionId", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SubmissionReviewEvent_actorId_offeringId_fkey" FOREIGN KEY ("actorId", "offeringId") REFERENCES "CourseMember"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SubmissionReviewEvent_versionId_revision_key" ON "SubmissionReviewEvent"("versionId", "revision");
CREATE INDEX "SubmissionReviewEvent_versionId_createdAt_idx" ON "SubmissionReviewEvent"("versionId", "createdAt");

-- Existing comments cannot prove that a review was completed. Do not invent a
-- completion actor/date, nor add these ambiguous records to the pending queue.
INSERT INTO "SubmissionVersionReview" ("versionId", "offeringId", "state", "revision")
SELECT v."id", v."offeringId", CASE WHEN EXISTS (
  SELECT 1 FROM "Review" r WHERE r."versionId" = v."id" AND r."offeringId" = v."offeringId"
) THEN 'LEGACY_UNKNOWN'::"SubmissionReviewStatus" ELSE 'PENDING'::"SubmissionReviewStatus" END, 1
FROM "SubmissionVersion" v WHERE v."finalizedAt" IS NOT NULL;
INSERT INTO "SubmissionReviewEvent" ("id", "versionId", "offeringId", "revision", "state", "isBaseline")
SELECT 'review-baseline-' || md5("versionId"), "versionId", "offeringId", 1, "state", true FROM "SubmissionVersionReview";

ALTER TABLE "GroupPage" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0);
ALTER TABLE "GroupPage" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE TABLE "GroupPageRevision" (
  "id" TEXT NOT NULL,
  "offeringId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL CHECK ("revision" > 0),
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "actorUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "isBaseline" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "GroupPageRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GroupPageRevision_groupId_offeringId_fkey" FOREIGN KEY ("groupId", "offeringId") REFERENCES "GroupPage"("groupId", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "GroupPageRevision_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GroupPageRevision_groupId_revision_key" ON "GroupPageRevision"("groupId", "revision");
CREATE INDEX "GroupPageRevision_groupId_createdAt_idx" ON "GroupPageRevision"("groupId", "createdAt");
INSERT INTO "GroupPageRevision" ("id", "offeringId", "groupId", "revision", "title", "body", "isBaseline")
SELECT 'group-page-baseline-' || md5("id"), "offeringId", "groupId", "revision", "title", "body", true FROM "GroupPage";

CREATE FUNCTION "prevent_workflow_history_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Workflow history is immutable' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "immutable_group_page_revision" BEFORE UPDATE OR DELETE ON "GroupPageRevision"
FOR EACH ROW EXECUTE FUNCTION "prevent_workflow_history_mutation"();
CREATE TRIGGER "immutable_submission_review_event" BEFORE UPDATE OR DELETE ON "SubmissionReviewEvent"
FOR EACH ROW EXECUTE FUNCTION "prevent_workflow_history_mutation"();

-- New review signatures carry the same permanent role attribution as comments.
CREATE OR REPLACE FUNCTION guard_member_role_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.role IS DISTINCT FROM OLD.role AND (
   EXISTS (SELECT 1 FROM "GroupMember" WHERE "courseMemberId" = OLD.id) OR
   EXISTS (SELECT 1 FROM "TaGroupAssignment" WHERE "courseMemberId" = OLD.id) OR
   EXISTS (SELECT 1 FROM "SubmissionParticipant" WHERE "courseMemberId" = OLD.id) OR
   EXISTS (SELECT 1 FROM "Submission" WHERE "courseMemberId" = OLD.id) OR
   EXISTS (SELECT 1 FROM "SubmissionVersion" WHERE "submittedById" = OLD.id) OR
   EXISTS (SELECT 1 FROM "Review" WHERE "reviewerId" = OLD.id) OR
   EXISTS (SELECT 1 FROM "SubmissionVersionReview" WHERE "updatedById" = OLD.id) OR
   EXISTS (SELECT 1 FROM "SubmissionReviewEvent" WHERE "actorId" = OLD.id) OR
   EXISTS (SELECT 1 FROM "GradeRecord" WHERE "courseMemberId" = OLD.id OR "updatedById" = OLD.id) OR
   EXISTS (SELECT 1 FROM "GradeHistory" WHERE "actorId" = OLD.id) OR
   EXISTS (SELECT 1 FROM "TeachingNote" WHERE "courseMemberId" = OLD.id)
 ) THEN RAISE EXCEPTION 'Cannot change role of a member with academic records'; END IF;
 RETURN NEW;
END; $$;

CREATE FUNCTION guard_submission_review_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND (NEW."versionId" IS DISTINCT FROM OLD."versionId" OR NEW."offeringId" IS DISTINCT FROM OLD."offeringId") THEN
   RAISE EXCEPTION 'Review state belongs permanently to its submission version';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM "SubmissionVersion" WHERE "id" = NEW."versionId" AND "offeringId" = NEW."offeringId" AND "finalizedAt" IS NOT NULL) THEN
   RAISE EXCEPTION 'Review state requires a sealed submission';
 END IF;
 IF NEW."updatedById" IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM "CourseMember" WHERE "id" = NEW."updatedById" AND "offeringId" = NEW."offeringId" AND "role" IN ('TEACHER', 'TA') AND "status" = 'ACTIVE'
 ) THEN RAISE EXCEPTION 'Review decisions require an active teaching member'; END IF;
 IF NEW."state" = 'COMPLETED' AND NEW."updatedById" IS NULL THEN
   RAISE EXCEPTION 'Completed reviews require explicit attribution';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER submission_review_state_valid BEFORE INSERT OR UPDATE ON "SubmissionVersionReview"
FOR EACH ROW EXECUTE FUNCTION guard_submission_review_state();

CREATE FUNCTION validate_submission_review_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM "SubmissionVersionReview" r WHERE r."versionId" = NEW."versionId" AND r."offeringId" = NEW."offeringId"
   AND r."revision" = NEW."revision" AND r."state" = NEW."state" AND r."updatedById" IS NOT DISTINCT FROM NEW."actorId"
 ) THEN RAISE EXCEPTION 'Review event must describe the current attributed state'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER submission_review_event_valid BEFORE INSERT ON "SubmissionReviewEvent"
FOR EACH ROW EXECUTE FUNCTION validate_submission_review_event();
