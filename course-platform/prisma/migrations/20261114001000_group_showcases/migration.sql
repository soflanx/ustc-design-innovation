BEGIN;

CREATE TYPE "GroupShowcaseScope" AS ENUM ('CLASS', 'PUBLIC');

CREATE TABLE "GroupShowcaseDraft" (
    "groupId" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "selections" JSONB NOT NULL,
    CONSTRAINT "GroupShowcaseDraft_pkey" PRIMARY KEY ("groupId"),
    CONSTRAINT "GroupShowcaseDraft_groupId_offeringId_fkey" FOREIGN KEY ("groupId", "offeringId") REFERENCES "Group"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GroupShowcaseDraft_groupId_offeringId_key" ON "GroupShowcaseDraft"("groupId", "offeringId");

CREATE TABLE "GroupShowcasePublication" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "scope" "GroupShowcaseScope" NOT NULL,
    "sequence" INTEGER NOT NULL,
    "draftRevision" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "publisherId" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnById" TEXT,
    CONSTRAINT "GroupShowcasePublication_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GroupShowcasePublication_groupId_offeringId_fkey" FOREIGN KEY ("groupId", "offeringId") REFERENCES "Group"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GroupShowcasePublication_publisherId_offeringId_fkey" FOREIGN KEY ("publisherId", "offeringId") REFERENCES "CourseMember"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GroupShowcasePublication_withdrawnById_offeringId_fkey" FOREIGN KEY ("withdrawnById", "offeringId") REFERENCES "CourseMember"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GroupShowcasePublication_withdrawal" CHECK (("withdrawnAt" IS NULL) = ("withdrawnById" IS NULL))
);
CREATE UNIQUE INDEX "GroupShowcasePublication_id_offeringId_key" ON "GroupShowcasePublication"("id", "offeringId");
CREATE UNIQUE INDEX "GroupShowcasePublication_offeringId_groupId_scope_sequence_key" ON "GroupShowcasePublication"("offeringId", "groupId", "scope", "sequence");
-- Protect the one current publication per reader scope independently.
CREATE UNIQUE INDEX "GroupShowcasePublication_current" ON "GroupShowcasePublication"("offeringId", "groupId", "scope")
    WHERE "withdrawnAt" IS NULL AND "supersededAt" IS NULL;

CREATE TABLE "GroupShowcaseMaterial" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "caption" TEXT NOT NULL,
    "sourceLabel" TEXT NOT NULL,
    "text" TEXT,
    "fileId" TEXT,
    "fileName" TEXT,
    "image" BOOLEAN NOT NULL DEFAULT false,
    "activityId" TEXT,
    "versionId" TEXT,
    CONSTRAINT "GroupShowcaseMaterial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GroupShowcaseMaterial_publicationId_offeringId_fkey" FOREIGN KEY ("publicationId", "offeringId") REFERENCES "GroupShowcasePublication"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GroupShowcaseMaterial_activityId_offeringId_fkey" FOREIGN KEY ("activityId", "offeringId") REFERENCES "GroupActivity"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GroupShowcaseMaterial_versionId_offeringId_fkey" FOREIGN KEY ("versionId", "offeringId") REFERENCES "SubmissionVersion"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GroupShowcaseMaterial_fileId_offeringId_fkey" FOREIGN KEY ("fileId", "offeringId") REFERENCES "FileObject"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GroupShowcaseMaterial_one_source" CHECK (("activityId" IS NULL) <> ("versionId" IS NULL)),
    CONSTRAINT "GroupShowcaseMaterial_text_or_file" CHECK (
      ("fileId" IS NULL AND "fileName" IS NULL AND "text" IS NOT NULL AND NOT "image")
      OR ("fileId" IS NOT NULL AND "fileName" IS NOT NULL AND "text" IS NULL)
    )
);
CREATE UNIQUE INDEX "GroupShowcaseMaterial_publicationId_position_key" ON "GroupShowcaseMaterial"("publicationId", "position");
CREATE INDEX "GroupShowcaseMaterial_fileId_idx" ON "GroupShowcaseMaterial"("fileId");

-- The approved attachment references the original bytes. File delivery remains
-- separate, and withdrawing a showcase stops using its public alias.
CREATE FUNCTION guard_showcase_material_file() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "GroupShowcaseMaterial" WHERE "fileId" = OLD.id) THEN
    RAISE EXCEPTION 'Files in confirmed group showcases are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER group_showcase_file_immutable BEFORE UPDATE OR DELETE ON "FileObject" FOR EACH ROW EXECUTE FUNCTION guard_showcase_material_file();

COMMIT;
