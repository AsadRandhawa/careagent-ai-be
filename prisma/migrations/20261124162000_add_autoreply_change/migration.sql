-- CreateTable
CREATE TABLE "AutoReplyChange" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoReplyChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutoReplyChange_userId_idx" ON "AutoReplyChange"("userId");

-- AddForeignKey
ALTER TABLE "AutoReplyChange" ADD CONSTRAINT "AutoReplyChange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
