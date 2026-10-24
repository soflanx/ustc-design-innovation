-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TermStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('STUDENT', 'TA', 'TEACHER');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('PUBLIC', 'OFFERING');

-- CreateEnum
CREATE TYPE "PostType" AS ENUM ('NEWS', 'PROJECT');

-- CreateEnum
CREATE TYPE "GradeStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "AssignmentMode" AS ENUM ('INDIVIDUAL', 'GROUP');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseStaff" (
    "courseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'TEACHER',

    CONSTRAINT "CourseStaff_pkey" PRIMARY KEY ("courseId","userId")
);

-- CreateTable
CREATE TABLE "Term" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TermStatus" NOT NULL DEFAULT 'DRAFT',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Term_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseOffering" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "TermStatus" NOT NULL DEFAULT 'DRAFT',

    CONSTRAINT "CourseOffering_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseMember" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL,
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourseMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMember" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "courseMemberId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaGroupAssignment" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "courseMemberId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "TaGroupAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "mode" "AssignmentMode" NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "dueAt" TIMESTAMP(3),
    "maxScore" DECIMAL(8,2) NOT NULL DEFAULT 100,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "courseMemberId" TEXT,
    "groupId" TEXT,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionVersion" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedById" TEXT NOT NULL,
    "finalizedAt" TIMESTAMP(3),

    CONSTRAINT "SubmissionVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionParticipant" (
    "offeringId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "courseMemberId" TEXT NOT NULL,

    CONSTRAINT "SubmissionParticipant_pkey" PRIMARY KEY ("versionId","courseMemberId")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "score" DECIMAL(8,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GradeRecord" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "courseMemberId" TEXT NOT NULL,
    "score" DECIMAL(8,2) NOT NULL,
    "status" "GradeStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "reviewId" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GradeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GradeHistory" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "gradeRecordId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "previousScore" DECIMAL(8,2),
    "score" DECIMAL(8,2) NOT NULL,
    "status" "GradeStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GradeHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileObject" (
    "offeringId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionFile" (
    "offeringId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,

    CONSTRAINT "SubmissionFile_pkey" PRIMARY KEY ("versionId","fileId")
);

-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "url" TEXT,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "visibility" "Visibility" NOT NULL DEFAULT 'OFFERING',

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Post" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "coverLabel" TEXT NOT NULL DEFAULT '示例内容',
    "excerpt" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "type" "PostType" NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "visibility" "Visibility" NOT NULL DEFAULT 'OFFERING',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupPage" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "visibility" "Visibility" NOT NULL DEFAULT 'OFFERING',

    CONSTRAINT "GroupPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeachingNote" (
    "courseMemberId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeachingNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_tokenHash_key" ON "AuthSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthSession_userId_expiresAt_idx" ON "AuthSession"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Course_slug_key" ON "Course"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Term_slug_key" ON "Term"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "CourseOffering_courseId_termId_key" ON "CourseOffering"("courseId", "termId");

-- CreateIndex
CREATE INDEX "CourseMember_offeringId_role_status_idx" ON "CourseMember"("offeringId", "role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CourseMember_offeringId_userId_key" ON "CourseMember"("offeringId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CourseMember_id_offeringId_key" ON "CourseMember"("id", "offeringId");

-- CreateIndex
CREATE UNIQUE INDEX "Group_offeringId_name_key" ON "Group"("offeringId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Group_id_offeringId_key" ON "Group"("id", "offeringId");

-- CreateIndex
CREATE INDEX "GroupMember_groupId_leftAt_idx" ON "GroupMember"("groupId", "leftAt");

-- CreateIndex
CREATE INDEX "GroupMember_courseMemberId_joinedAt_idx" ON "GroupMember"("courseMemberId", "joinedAt");

-- CreateIndex
CREATE INDEX "TaGroupAssignment_courseMemberId_endedAt_idx" ON "TaGroupAssignment"("courseMemberId", "endedAt");

-- CreateIndex
CREATE INDEX "Assignment_offeringId_status_idx" ON "Assignment"("offeringId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Assignment_id_offeringId_key" ON "Assignment"("id", "offeringId");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_id_offeringId_key" ON "Submission"("id", "offeringId");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_assignmentId_courseMemberId_key" ON "Submission"("assignmentId", "courseMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_assignmentId_groupId_key" ON "Submission"("assignmentId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionVersion_submissionId_version_key" ON "SubmissionVersion"("submissionId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionVersion_id_offeringId_key" ON "SubmissionVersion"("id", "offeringId");

-- CreateIndex
CREATE INDEX "Review_versionId_createdAt_idx" ON "Review"("versionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Review_id_offeringId_key" ON "Review"("id", "offeringId");

-- CreateIndex
CREATE UNIQUE INDEX "GradeRecord_assignmentId_courseMemberId_key" ON "GradeRecord"("assignmentId", "courseMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "GradeRecord_id_offeringId_key" ON "GradeRecord"("id", "offeringId");

-- CreateIndex
CREATE INDEX "GradeHistory_gradeRecordId_recordedAt_idx" ON "GradeHistory"("gradeRecordId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FileObject_storageKey_key" ON "FileObject"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "FileObject_id_offeringId_key" ON "FileObject"("id", "offeringId");

-- CreateIndex
CREATE INDEX "Resource_offeringId_status_idx" ON "Resource"("offeringId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Post_slug_key" ON "Post"("slug");

-- CreateIndex
CREATE INDEX "Post_status_visibility_publishedAt_idx" ON "Post"("status", "visibility", "publishedAt");

-- CreateIndex
CREATE INDEX "Post_offeringId_type_idx" ON "Post"("offeringId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "GroupPage_groupId_key" ON "GroupPage"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupPage_groupId_offeringId_key" ON "GroupPage"("groupId", "offeringId");

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseStaff" ADD CONSTRAINT "CourseStaff_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseStaff" ADD CONSTRAINT "CourseStaff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseOffering" ADD CONSTRAINT "CourseOffering_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseOffering" ADD CONSTRAINT "CourseOffering_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseMember" ADD CONSTRAINT "CourseMember_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseMember" ADD CONSTRAINT "CourseMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_offeringId_fkey" FOREIGN KEY ("groupId", "offeringId") REFERENCES "Group"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_courseMemberId_offeringId_fkey" FOREIGN KEY ("courseMemberId", "offeringId") REFERENCES "CourseMember"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaGroupAssignment" ADD CONSTRAINT "TaGroupAssignment_groupId_offeringId_fkey" FOREIGN KEY ("groupId", "offeringId") REFERENCES "Group"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaGroupAssignment" ADD CONSTRAINT "TaGroupAssignment_courseMemberId_offeringId_fkey" FOREIGN KEY ("courseMemberId", "offeringId") REFERENCES "CourseMember"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_assignmentId_offeringId_fkey" FOREIGN KEY ("assignmentId", "offeringId") REFERENCES "Assignment"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_courseMemberId_offeringId_fkey" FOREIGN KEY ("courseMemberId", "offeringId") REFERENCES "CourseMember"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_groupId_offeringId_fkey" FOREIGN KEY ("groupId", "offeringId") REFERENCES "Group"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionVersion" ADD CONSTRAINT "SubmissionVersion_submissionId_offeringId_fkey" FOREIGN KEY ("submissionId", "offeringId") REFERENCES "Submission"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionVersion" ADD CONSTRAINT "SubmissionVersion_submittedById_offeringId_fkey" FOREIGN KEY ("submittedById", "offeringId") REFERENCES "CourseMember"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionParticipant" ADD CONSTRAINT "SubmissionParticipant_versionId_offeringId_fkey" FOREIGN KEY ("versionId", "offeringId") REFERENCES "SubmissionVersion"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionParticipant" ADD CONSTRAINT "SubmissionParticipant_courseMemberId_offeringId_fkey" FOREIGN KEY ("courseMemberId", "offeringId") REFERENCES "CourseMember"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_versionId_offeringId_fkey" FOREIGN KEY ("versionId", "offeringId") REFERENCES "SubmissionVersion"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_reviewerId_offeringId_fkey" FOREIGN KEY ("reviewerId", "offeringId") REFERENCES "CourseMember"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeRecord" ADD CONSTRAINT "GradeRecord_assignmentId_offeringId_fkey" FOREIGN KEY ("assignmentId", "offeringId") REFERENCES "Assignment"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeRecord" ADD CONSTRAINT "GradeRecord_courseMemberId_offeringId_fkey" FOREIGN KEY ("courseMemberId", "offeringId") REFERENCES "CourseMember"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeRecord" ADD CONSTRAINT "GradeRecord_reviewId_offeringId_fkey" FOREIGN KEY ("reviewId", "offeringId") REFERENCES "Review"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeRecord" ADD CONSTRAINT "GradeRecord_updatedById_offeringId_fkey" FOREIGN KEY ("updatedById", "offeringId") REFERENCES "CourseMember"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeHistory" ADD CONSTRAINT "GradeHistory_gradeRecordId_offeringId_fkey" FOREIGN KEY ("gradeRecordId", "offeringId") REFERENCES "GradeRecord"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeHistory" ADD CONSTRAINT "GradeHistory_actorId_offeringId_fkey" FOREIGN KEY ("actorId", "offeringId") REFERENCES "CourseMember"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileObject" ADD CONSTRAINT "FileObject_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileObject" ADD CONSTRAINT "FileObject_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionFile" ADD CONSTRAINT "SubmissionFile_versionId_offeringId_fkey" FOREIGN KEY ("versionId", "offeringId") REFERENCES "SubmissionVersion"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionFile" ADD CONSTRAINT "SubmissionFile_fileId_offeringId_fkey" FOREIGN KEY ("fileId", "offeringId") REFERENCES "FileObject"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupPage" ADD CONSTRAINT "GroupPage_groupId_offeringId_fkey" FOREIGN KEY ("groupId", "offeringId") REFERENCES "Group"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeachingNote" ADD CONSTRAINT "TeachingNote_courseMemberId_offeringId_fkey" FOREIGN KEY ("courseMemberId", "offeringId") REFERENCES "CourseMember"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeachingNote" ADD CONSTRAINT "TeachingNote_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- PostgreSQL-only constraints; Prisma schema cannot express these.
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_owner_exactly_one" CHECK (("courseMemberId" IS NOT NULL)::int + ("groupId" IS NOT NULL)::int = 1);
ALTER TABLE "Term" ADD CONSTRAINT "Term_dates_ordered" CHECK ("endDate" > "startDate");
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_dates_ordered" CHECK ("leftAt" IS NULL OR "leftAt" >= "joinedAt");
ALTER TABLE "TaGroupAssignment" ADD CONSTRAINT "TaGroupAssignment_dates_ordered" CHECK ("endedAt" IS NULL OR "endedAt" >= "assignedAt");
ALTER TABLE "CourseStaff" ADD CONSTRAINT "CourseStaff_teacher_only" CHECK (role = 'TEACHER');
ALTER TABLE "SubmissionVersion" ADD CONSTRAINT "SubmissionVersion_positive" CHECK (version > 0);
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_maxScore_nonnegative" CHECK ("maxScore" >= 0);
ALTER TABLE "GradeRecord" ADD CONSTRAINT "GradeRecord_score_nonnegative" CHECK (score >= 0);
ALTER TABLE "FileObject" ADD CONSTRAINT "FileObject_size_nonnegative" CHECK ("sizeBytes" >= 0);
ALTER TABLE "Post" ADD CONSTRAINT "Post_scoped_or_public" CHECK ("offeringId" IS NOT NULL OR visibility = 'PUBLIC');
CREATE UNIQUE INDEX "GroupMember_one_active_group" ON "GroupMember" ("offeringId", "courseMemberId") WHERE "leftAt" IS NULL;
CREATE UNIQUE INDEX "TaGroupAssignment_active_pair" ON "TaGroupAssignment" ("groupId", "courseMemberId") WHERE "endedAt" IS NULL;

-- Role/mode rules involve another table and therefore require triggers.
CREATE FUNCTION check_membership_role() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE member_role "MemberRole";
BEGIN
 SELECT role INTO member_role FROM "CourseMember" WHERE id = NEW."courseMemberId" AND "offeringId" = NEW."offeringId";
 IF TG_TABLE_NAME = 'GroupMember' AND member_role <> 'STUDENT' THEN RAISE EXCEPTION 'Only students may join groups'; END IF;
 IF TG_TABLE_NAME = 'TaGroupAssignment' AND member_role <> 'TA' THEN RAISE EXCEPTION 'Only teaching assistants may receive TA assignments'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER group_member_role BEFORE INSERT OR UPDATE ON "GroupMember" FOR EACH ROW EXECUTE FUNCTION check_membership_role();
CREATE TRIGGER ta_assignment_role BEFORE INSERT OR UPDATE ON "TaGroupAssignment" FOR EACH ROW EXECUTE FUNCTION check_membership_role();
CREATE FUNCTION check_submission_owner_mode() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assignment_mode "AssignmentMode";
BEGIN
 SELECT mode INTO assignment_mode FROM "Assignment" WHERE id = NEW."assignmentId";
 IF (assignment_mode = 'INDIVIDUAL' AND NEW."courseMemberId" IS NULL) OR (assignment_mode = 'GROUP' AND NEW."groupId" IS NULL) THEN RAISE EXCEPTION 'Submission owner must match assignment mode'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER submission_owner_mode BEFORE INSERT OR UPDATE ON "Submission" FOR EACH ROW EXECUTE FUNCTION check_submission_owner_mode();



CREATE FUNCTION guard_member_role_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.role IS DISTINCT FROM OLD.role AND (
   EXISTS (SELECT 1 FROM "GroupMember" WHERE "courseMemberId" = OLD.id) OR
   EXISTS (SELECT 1 FROM "TaGroupAssignment" WHERE "courseMemberId" = OLD.id) OR
   EXISTS (SELECT 1 FROM "SubmissionParticipant" WHERE "courseMemberId" = OLD.id) OR
   EXISTS (SELECT 1 FROM "GradeRecord" WHERE "courseMemberId" = OLD.id)
 ) THEN RAISE EXCEPTION 'Cannot change role of a member with academic records'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER member_role_history BEFORE UPDATE OF role ON "CourseMember" FOR EACH ROW EXECUTE FUNCTION guard_member_role_change();
CREATE FUNCTION guard_assignment_mode_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.mode IS DISTINCT FROM OLD.mode AND EXISTS (SELECT 1 FROM "Submission" WHERE "assignmentId" = OLD.id) THEN RAISE EXCEPTION 'Cannot change assignment mode after submissions exist'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER assignment_mode_history BEFORE UPDATE OF mode ON "Assignment" FOR EACH ROW EXECUTE FUNCTION guard_assignment_mode_change();

ALTER TABLE "GradeRecord" ADD CONSTRAINT grade_publication_consistency CHECK ((status = 'PUBLISHED') = ("publishedAt" IS NOT NULL));
CREATE FUNCTION guard_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."finalizedAt" IS NOT NULL THEN RAISE EXCEPTION 'Finalized versions are immutable'; END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER version_sealed BEFORE UPDATE OR DELETE ON "SubmissionVersion" FOR EACH ROW EXECUTE FUNCTION guard_version_mutation();
CREATE FUNCTION guard_version_relation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_id text; new_id text;
BEGIN
 IF TG_OP <> 'INSERT' THEN old_id := OLD."versionId"; END IF;
 IF TG_OP <> 'DELETE' THEN new_id := NEW."versionId"; END IF;
 -- Row lock serializes additions and sealing, including concurrent transactions.
 PERFORM id FROM "SubmissionVersion" WHERE id IN (old_id,new_id) ORDER BY id FOR UPDATE;
 IF EXISTS (SELECT 1 FROM "SubmissionVersion" WHERE id IN (old_id,new_id) AND "finalizedAt" IS NOT NULL) THEN RAISE EXCEPTION 'Finalized version associations are immutable'; END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER participant_sealed BEFORE INSERT OR UPDATE OR DELETE ON "SubmissionParticipant" FOR EACH ROW EXECUTE FUNCTION guard_version_relation();
CREATE TRIGGER attachment_sealed BEFORE INSERT OR UPDATE OR DELETE ON "SubmissionFile" FOR EACH ROW EXECUTE FUNCTION guard_version_relation();
CREATE FUNCTION validate_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "SubmissionVersion" WHERE id=NEW."versionId" AND "finalizedAt" IS NOT NULL) THEN RAISE EXCEPTION 'Review requires a finalized version'; END IF;
 IF NOT EXISTS (SELECT 1 FROM "CourseMember" WHERE id=NEW."reviewerId" AND role IN ('TEACHER','TA')) THEN RAISE EXCEPTION 'Reviewer must be teaching staff'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER review_valid BEFORE INSERT OR UPDATE ON "Review" FOR EACH ROW EXECUTE FUNCTION validate_review();
CREATE FUNCTION validate_grade() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "CourseMember" WHERE id=NEW."courseMemberId" AND role='STUDENT') THEN RAISE EXCEPTION 'Grade must belong to a student'; END IF;
 IF NOT EXISTS (SELECT 1 FROM "CourseMember" WHERE id=NEW."updatedById" AND role IN ('TEACHER','TA')) THEN RAISE EXCEPTION 'Grade updater must be teaching staff'; END IF;
 IF NOT EXISTS (SELECT 1 FROM "Review" r JOIN "SubmissionVersion" v ON v.id=r."versionId" JOIN "Submission" s ON s.id=v."submissionId" JOIN "SubmissionParticipant" p ON p."versionId"=v.id WHERE r.id=NEW."reviewId" AND s."assignmentId"=NEW."assignmentId" AND p."courseMemberId"=NEW."courseMemberId") THEN RAISE EXCEPTION 'Grade source must match assignment and student snapshot'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER grade_valid BEFORE INSERT OR UPDATE ON "GradeRecord" FOR EACH ROW EXECUTE FUNCTION validate_grade();
CREATE FUNCTION validate_grade_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Grade history is immutable'; END IF;
 IF NOT EXISTS (SELECT 1 FROM "CourseMember" WHERE id=NEW."actorId" AND role IN ('TEACHER','TA')) THEN RAISE EXCEPTION 'Grade history actor must be teaching staff'; END IF;
 IF length(trim(NEW.reason))=0 THEN RAISE EXCEPTION 'Grade history requires a reason'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER grade_history_valid BEFORE INSERT OR UPDATE OR DELETE ON "GradeHistory" FOR EACH ROW EXECUTE FUNCTION validate_grade_history();
