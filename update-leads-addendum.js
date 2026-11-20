// update-leads-addendum.js
//
// Sets User.nativeRagPromptAddendum from a local text file, via Prisma's
// parameterized update — avoids pasting ~200 lines into an interactive
// psql session, which corrupted the $$ dollar-quoted string in the
// terminal (stray characters spliced into the paste, breaking the SQL).
//
// Usage:
//   node update-leads-addendum.js "0437029b-c10b-4451-bafb-7992769ddb48" leads-addendum-content.txt

import 'dotenv/config';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const [, , userId, filePath] = process.argv;
if (!userId || !filePath) {
  console.error('Usage: node update-leads-addendum.js <userId> <path-to-addendum-text-file>');
  process.exit(1);
}
if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const addendumText = fs.readFileSync(filePath, 'utf-8');

async function main() {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { nativeRagPromptAddendum: addendumText },
  });
  console.log(`Updated nativeRagPromptAddendum for ${updated.email} (${updated.id}).`);
  console.log(`Length: ${addendumText.length} characters.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Update failed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
