-- An existing review is permanently attached to its original version and reviewer.
-- Feedback text/score can be edited; academic source and attribution cannot.
CREATE FUNCTION guard_review_source_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."versionId" IS DISTINCT FROM OLD."versionId"
    OR NEW."offeringId" IS DISTINCT FROM OLD."offeringId"
    OR NEW."reviewerId" IS DISTINCT FROM OLD."reviewerId" THEN
   RAISE EXCEPTION 'Review source and reviewer attribution are immutable';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER review_source_history BEFORE UPDATE ON "Review" FOR EACH ROW EXECUTE FUNCTION guard_review_source_change();

CREATE OR REPLACE FUNCTION guard_member_role_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.role IS DISTINCT FROM OLD.role AND (
   EXISTS (SELECT 1 FROM "GroupMember" WHERE "courseMemberId" = OLD.id) OR
   EXISTS (SELECT 1 FROM "TaGroupAssignment" WHERE "courseMemberId" = OLD.id) OR
   EXISTS (SELECT 1 FROM "SubmissionParticipant" WHERE "courseMemberId" = OLD.id) OR
   EXISTS (SELECT 1 FROM "Submission" WHERE "courseMemberId" = OLD.id) OR
   EXISTS (SELECT 1 FROM "SubmissionVersion" WHERE "submittedById" = OLD.id) OR
   EXISTS (SELECT 1 FROM "Review" WHERE "reviewerId" = OLD.id) OR
   EXISTS (SELECT 1 FROM "GradeRecord" WHERE "courseMemberId" = OLD.id OR "updatedById" = OLD.id) OR
   EXISTS (SELECT 1 FROM "GradeHistory" WHERE "actorId" = OLD.id) OR
   EXISTS (SELECT 1 FROM "TeachingNote" WHERE "courseMemberId" = OLD.id)
 ) THEN RAISE EXCEPTION 'Cannot change role of a member with academic records'; END IF;
 RETURN NEW;
END; $$;
