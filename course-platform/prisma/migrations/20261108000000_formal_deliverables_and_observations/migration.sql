-- Existing sealed submissions, reviews and files remain unchanged.
ALTER TABLE "FileObject" ADD COLUMN "bytes" BYTEA;
ALTER TABLE "SubmissionVersion" ADD COLUMN "requestFingerprint" TEXT;
ALTER TABLE "Submission" ADD COLUMN "correctionUntil" TIMESTAMP(3), ADD COLUMN "correctionRevision" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "SubmissionCorrectionEvent" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "until" TIMESTAMP(3),
    "actorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubmissionCorrectionEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TeachingObservation" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "targetMemberId" TEXT,
    "targetGroupId" TEXT,
    "versionId" TEXT,
    "body" TEXT NOT NULL,
    "context" TEXT NOT NULL DEFAULT '',
    "observedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestId" TEXT NOT NULL,

    CONSTRAINT "TeachingObservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TeachingFeedback" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "targetMemberId" TEXT,
    "targetGroupId" TEXT,
    "versionId" TEXT,
    "body" TEXT NOT NULL,
    "context" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestId" TEXT NOT NULL,

    CONSTRAINT "TeachingFeedback_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TeachingFeedbackRecipient" (
    "offeringId" TEXT NOT NULL,
    "feedbackId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,

    CONSTRAINT "TeachingFeedbackRecipient_pkey" PRIMARY KEY ("feedbackId","memberId")
);

CREATE UNIQUE INDEX "SubmissionCorrectionEvent_submissionId_revision_key" ON "SubmissionCorrectionEvent"("submissionId", "revision");

CREATE UNIQUE INDEX "TeachingObservation_requestId_key" ON "TeachingObservation"("requestId");

CREATE INDEX "TeachingObservation_offeringId_targetMemberId_createdAt_idx" ON "TeachingObservation"("offeringId", "targetMemberId", "createdAt");

CREATE INDEX "TeachingObservation_offeringId_targetGroupId_createdAt_idx" ON "TeachingObservation"("offeringId", "targetGroupId", "createdAt");

CREATE UNIQUE INDEX "TeachingFeedback_requestId_key" ON "TeachingFeedback"("requestId");

CREATE INDEX "TeachingFeedback_offeringId_targetMemberId_createdAt_idx" ON "TeachingFeedback"("offeringId", "targetMemberId", "createdAt");

CREATE INDEX "TeachingFeedback_offeringId_targetGroupId_createdAt_idx" ON "TeachingFeedback"("offeringId", "targetGroupId", "createdAt");

CREATE UNIQUE INDEX "TeachingFeedback_id_offeringId_key" ON "TeachingFeedback"("id", "offeringId");

CREATE INDEX "TeachingFeedbackRecipient_memberId_offeringId_idx" ON "TeachingFeedbackRecipient"("memberId", "offeringId");

ALTER TABLE "SubmissionCorrectionEvent" ADD CONSTRAINT "SubmissionCorrectionEvent_submissionId_offeringId_fkey" FOREIGN KEY ("submissionId", "offeringId") REFERENCES "Submission"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SubmissionCorrectionEvent" ADD CONSTRAINT "SubmissionCorrectionEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TeachingObservation" ADD CONSTRAINT "TeachingObservation_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TeachingObservation" ADD CONSTRAINT "TeachingObservation_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TeachingObservation" ADD CONSTRAINT "TeachingObservation_targetMemberId_offeringId_fkey" FOREIGN KEY ("targetMemberId", "offeringId") REFERENCES "CourseMember"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TeachingObservation" ADD CONSTRAINT "TeachingObservation_targetGroupId_offeringId_fkey" FOREIGN KEY ("targetGroupId", "offeringId") REFERENCES "Group"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TeachingObservation" ADD CONSTRAINT "TeachingObservation_versionId_offeringId_fkey" FOREIGN KEY ("versionId", "offeringId") REFERENCES "SubmissionVersion"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TeachingFeedback" ADD CONSTRAINT "TeachingFeedback_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TeachingFeedback" ADD CONSTRAINT "TeachingFeedback_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TeachingFeedback" ADD CONSTRAINT "TeachingFeedback_targetMemberId_offeringId_fkey" FOREIGN KEY ("targetMemberId", "offeringId") REFERENCES "CourseMember"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TeachingFeedback" ADD CONSTRAINT "TeachingFeedback_targetGroupId_offeringId_fkey" FOREIGN KEY ("targetGroupId", "offeringId") REFERENCES "Group"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TeachingFeedback" ADD CONSTRAINT "TeachingFeedback_versionId_offeringId_fkey" FOREIGN KEY ("versionId", "offeringId") REFERENCES "SubmissionVersion"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TeachingFeedbackRecipient" ADD CONSTRAINT "TeachingFeedbackRecipient_feedbackId_offeringId_fkey" FOREIGN KEY ("feedbackId", "offeringId") REFERENCES "TeachingFeedback"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TeachingFeedbackRecipient" ADD CONSTRAINT "TeachingFeedbackRecipient_memberId_offeringId_fkey" FOREIGN KEY ("memberId", "offeringId") REFERENCES "CourseMember"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A note has one subject. A version supplies context, not a new audience.
ALTER TABLE "TeachingObservation" ADD CONSTRAINT "TeachingObservation_one_target" CHECK (("targetMemberId" IS NOT NULL)::integer + ("targetGroupId" IS NOT NULL)::integer = 1);
ALTER TABLE "TeachingFeedback" ADD CONSTRAINT "TeachingFeedback_one_target" CHECK (("targetMemberId" IS NOT NULL)::integer + ("targetGroupId" IS NOT NULL)::integer = 1);
ALTER TABLE "SubmissionCorrectionEvent" ADD CONSTRAINT "SubmissionCorrectionEvent_revision_positive" CHECK (revision > 0);

CREATE FUNCTION protect_teaching_observation_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Teaching records are append-only';
END;
$$;
CREATE TRIGGER teaching_observation_immutable BEFORE UPDATE OR DELETE ON "TeachingObservation" FOR EACH ROW EXECUTE FUNCTION protect_teaching_observation_history();
CREATE TRIGGER teaching_feedback_immutable BEFORE UPDATE OR DELETE ON "TeachingFeedback" FOR EACH ROW EXECUTE FUNCTION protect_teaching_observation_history();
CREATE TRIGGER teaching_feedback_recipient_immutable BEFORE UPDATE OR DELETE ON "TeachingFeedbackRecipient" FOR EACH ROW EXECUTE FUNCTION protect_teaching_observation_history();
CREATE TRIGGER submission_correction_event_immutable BEFORE UPDATE OR DELETE ON "SubmissionCorrectionEvent" FOR EACH ROW EXECUTE FUNCTION protect_teaching_observation_history();

-- A saved file is part of the sealed deliverable, not a mutable shared upload.
CREATE FUNCTION guard_sealed_submission_file() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "SubmissionFile" sf JOIN "SubmissionVersion" sv ON sv.id = sf."versionId"
    WHERE sf."fileId" = OLD.id AND sv."finalizedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Files in finalized submissions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sealed_submission_file_immutable BEFORE UPDATE OR DELETE ON "FileObject" FOR EACH ROW EXECUTE FUNCTION guard_sealed_submission_file();

-- Preserve the role of both subjects and teaching authors in the new records.
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
   EXISTS (SELECT 1 FROM "TeachingNote" WHERE "courseMemberId" = OLD.id) OR
   EXISTS (SELECT 1 FROM "TeachingObservation" WHERE "targetMemberId" = OLD.id OR ("offeringId" = OLD."offeringId" AND "authorUserId" = OLD."userId")) OR
   EXISTS (SELECT 1 FROM "TeachingFeedback" WHERE "targetMemberId" = OLD.id OR ("offeringId" = OLD."offeringId" AND "authorUserId" = OLD."userId")) OR
   EXISTS (SELECT 1 FROM "TeachingFeedbackRecipient" WHERE "memberId" = OLD.id) OR
   EXISTS (SELECT 1 FROM "SubmissionCorrectionEvent" WHERE "offeringId" = OLD."offeringId" AND "actorUserId" = OLD."userId")
 ) THEN RAISE EXCEPTION 'Cannot change role of a member with academic records'; END IF;
 RETURN NEW;
END; $$;
