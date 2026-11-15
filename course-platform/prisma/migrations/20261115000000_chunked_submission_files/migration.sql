ALTER TABLE "FileObject" ADD COLUMN "chunked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FileObject" ADD CONSTRAINT "FileObject_chunked_storage" CHECK (NOT "chunked" OR "bytes" IS NULL);

CREATE TABLE "FileObjectChunk" (
  "fileId" TEXT NOT NULL,
  "index" INTEGER NOT NULL,
  "bytes" BYTEA NOT NULL,
  CONSTRAINT "FileObjectChunk_pkey" PRIMARY KEY ("fileId", "index"),
  CONSTRAINT "FileObjectChunk_fileId_fkey" FOREIGN KEY ("fileId")
    REFERENCES "FileObject"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FileObjectChunk_index_nonnegative" CHECK ("index" >= 0),
  CONSTRAINT "FileObjectChunk_size" CHECK (octet_length("bytes") BETWEEN 1 AND 1048576)
);

CREATE TABLE "SubmissionUpload" (
  "fileId" TEXT NOT NULL,
  "offeringId" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "receivedBytes" INTEGER NOT NULL DEFAULT 0,
  "digest" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "SubmissionUpload_pkey" PRIMARY KEY ("fileId"),
  CONSTRAINT "SubmissionUpload_fileId_offeringId_fkey" FOREIGN KEY ("fileId", "offeringId")
    REFERENCES "FileObject"("id", "offeringId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SubmissionUpload_assignmentId_offeringId_fkey" FOREIGN KEY ("assignmentId", "offeringId")
    REFERENCES "Assignment"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SubmissionUpload_received_nonnegative" CHECK ("receivedBytes" >= 0),
  CONSTRAINT "SubmissionUpload_digest" CHECK (
    ("receivedBytes" = 0 AND "digest" IS NULL) OR
    ("receivedBytes" > 0 AND "digest" IS NOT NULL AND "digest" ~ '^[0-9a-f]{64}$')
  )
);

CREATE UNIQUE INDEX "SubmissionUpload_fileId_offeringId_key" ON "SubmissionUpload"("fileId", "offeringId");
CREATE INDEX "SubmissionUpload_expiresAt_fileId_idx" ON "SubmissionUpload"("expiresAt", "fileId");
CREATE INDEX "SubmissionFile_fileId_idx" ON "SubmissionFile"("fileId");

-- A chunk append, a final submission, and an expired-upload deletion all
-- coordinate on FileObject. The media served by a sealed version is immutable.
CREATE FUNCTION protect_submission_upload_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."fileId" IS DISTINCT FROM OLD."fileId" THEN
      RAISE EXCEPTION 'Submission uploads cannot change file identity';
    END IF;
  END IF;
  target_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."fileId" ELSE NEW."fileId" END;
  PERFORM 1 FROM "FileObject" WHERE "id" = target_id FOR NO KEY UPDATE;
  IF EXISTS (
    SELECT 1 FROM "SubmissionFile" sf JOIN "SubmissionVersion" sv ON sv."id" = sf."versionId"
    WHERE sf."fileId" = target_id AND sv."finalizedAt" IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM "GroupShowcaseMaterial" WHERE "fileId" = target_id
  ) THEN
    RAISE EXCEPTION 'Files in finalized submissions or showcases are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER file_object_chunk_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON "FileObjectChunk"
  FOR EACH ROW EXECUTE FUNCTION protect_submission_upload_content();
CREATE TRIGGER submission_upload_metadata_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON "SubmissionUpload"
  FOR EACH ROW EXECUTE FUNCTION protect_submission_upload_content();
