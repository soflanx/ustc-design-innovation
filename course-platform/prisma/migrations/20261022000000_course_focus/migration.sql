-- A freely edited current teaching focus belongs to one course offering.
CREATE UNIQUE INDEX "Resource_id_offeringId_key" ON "Resource"("id", "offeringId");

CREATE TABLE "CourseFocus" (
  "offeringId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL DEFAULT '',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CourseFocus_pkey" PRIMARY KEY ("offeringId")
);

CREATE TABLE "CourseFocusAssignment" (
  "offeringId" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  CONSTRAINT "CourseFocusAssignment_pkey" PRIMARY KEY ("offeringId", "assignmentId")
);

CREATE TABLE "CourseFocusResource" (
  "offeringId" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  CONSTRAINT "CourseFocusResource_pkey" PRIMARY KEY ("offeringId", "resourceId")
);

ALTER TABLE "CourseFocus" ADD CONSTRAINT "CourseFocus_offeringId_fkey"
  FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CourseFocusAssignment" ADD CONSTRAINT "CourseFocusAssignment_offeringId_fkey"
  FOREIGN KEY ("offeringId") REFERENCES "CourseFocus"("offeringId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CourseFocusAssignment" ADD CONSTRAINT "CourseFocusAssignment_assignmentId_offeringId_fkey"
  FOREIGN KEY ("assignmentId", "offeringId") REFERENCES "Assignment"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CourseFocusResource" ADD CONSTRAINT "CourseFocusResource_offeringId_fkey"
  FOREIGN KEY ("offeringId") REFERENCES "CourseFocus"("offeringId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CourseFocusResource" ADD CONSTRAINT "CourseFocusResource_resourceId_offeringId_fkey"
  FOREIGN KEY ("resourceId", "offeringId") REFERENCES "Resource"("id", "offeringId") ON DELETE RESTRICT ON UPDATE CASCADE;
