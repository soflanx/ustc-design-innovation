CREATE TABLE "ResourceFile" (
  "resourceId" TEXT PRIMARY KEY REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name" TEXT NOT NULL CHECK (char_length("name") BETWEEN 1 AND 255),
  "size" INTEGER NOT NULL CHECK ("size" BETWEEN 0 AND 10485760),
  "bytes" BYTEA NOT NULL CHECK (octet_length("bytes") = "size")
);
