// Step 2 of 3. One-time backfill script — run this manually, once, from
// your own machine or a Railway shell. It is NOT part of server.js and
// never runs automatically.
//
// ALWAYS run with --dry-run first and read the output carefully before
// running it for real. Dry-run mode does all the same work but wraps
// everything in a transaction that gets rolled back at the end, so
// nothing is actually written — it exists purely so you can see exactly
// what would happen first.
//
// Usage:
//   DATABASE_URL=postgresql://... node backfill_messages.js --dry-run
//   DATABASE_URL=postgresql://... node backfill_messages.js
//
// Requires the `pg` package: npm install pg --no-save (or add it
// temporarily to backend/package.json, your call — this script is meant
// to be run once and then can be deleted).

const { Client } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Run with: DATABASE_URL=postgresql://... node backfill_messages.js --dry-run');
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log(DRY_RUN ? '=== DRY RUN — no changes will be committed ===\n' : '=== LIVE RUN — this will modify your database ===\n');

  try {
    await client.query('BEGIN');

    const allTickets = (await client.query('SELECT * FROM "Ticket" ORDER BY "createdAt" ASC')).rows;
    console.log(`Found ${allTickets.length} existing ticket rows.\n`);

    // Group tickets that share the same (userId, channel, threadId) — these
    // are the ones that need consolidating into one real conversation.
    // Tickets with a null threadId, or a threadId no one else shares,
    // don't need consolidation — they just need their own Message row.
    const groups = new Map();
    const singles = [];

    for (const t of allTickets) {
      if (!t.threadId) { singles.push(t); continue; }
      const key = `${t.userId}|${t.channel}|${t.threadId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }

    let messagesCreated = 0;
    let ticketsConsolidated = 0;
    let duplicatesRemoved = 0;

    for (const [key, group] of groups.entries()) {
      if (group.length === 1) {
        singles.push(group[0]);
        continue;
      }

      group.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const canonical = group[0];
      const latest = group[group.length - 1];

      console.log(`Consolidating ${group.length} tickets sharing thread "${key}" -> keeping ticket ${canonical.id} as the conversation`);

      for (const t of group) {
        messagesCreated++;
        if (!DRY_RUN) {
          await client.query(
            `INSERT INTO "Message" (id, "ticketId", "externalId", direction, content, "senderName", "createdAt")
             VALUES (gen_random_uuid(), $1, $2, 'inbound', $3, $4, $5)
             ON CONFLICT ("ticketId", "externalId") DO NOTHING`,
            [canonical.id, t.externalId, t.content, t.customerName, t.receivedAt || t.createdAt]
          );
        }
      }

      if (!DRY_RUN) {
        // The conversation's top-level fields (content/receivedAt/status)
        // reflect whichever message is most recent, so the ticket list
        // preview shows the latest activity — same as any real inbox.
        await client.query(
          `UPDATE "Ticket" SET content = $1, "receivedAt" = $2, status = $3 WHERE id = $4`,
          [latest.content, latest.receivedAt || latest.createdAt, latest.status, canonical.id]
        );
      }
      ticketsConsolidated++;

      const duplicateIds = group.slice(1).map(t => t.id);
      if (duplicateIds.length > 0) {
        if (!DRY_RUN) {
          await client.query(`DELETE FROM "Ticket" WHERE id = ANY($1::text[])`, [duplicateIds]);
        }
        duplicatesRemoved += duplicateIds.length;
      }
    }

    // Tickets that never needed consolidating still need their own
    // Message row created, so their history is available the same way
    // as every other conversation going forward.
    for (const t of singles) {
      messagesCreated++;
      if (!DRY_RUN) {
        await client.query(
          `INSERT INTO "Message" (id, "ticketId", "externalId", direction, content, "senderName", "createdAt")
           VALUES (gen_random_uuid(), $1, $2, 'inbound', $3, $4, $5)
           ON CONFLICT ("ticketId", "externalId") DO NOTHING`,
          [t.id, t.externalId, t.content, t.customerName, t.receivedAt || t.createdAt]
        );
      }
    }

    console.log('\n── Summary ──────────────────────────────');
    console.log(`${DRY_RUN ? 'Would create' : 'Created'}: ${messagesCreated} Message rows total`);
    console.log(`${DRY_RUN ? 'Would consolidate' : 'Consolidated'}: ${ticketsConsolidated} conversations (had duplicate ticket rows sharing one thread)`);
    console.log(`${DRY_RUN ? 'Would delete' : 'Deleted'}: ${duplicatesRemoved} now-redundant duplicate ticket rows`);
    console.log(`Single-message conversations (no duplicates to consolidate): ${singles.length}`);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('\n✅ Dry run complete. Nothing was written — transaction rolled back.');
      console.log('Review the summary above, then re-run without --dry-run when ready.');
    } else {
      await client.query('COMMIT');
      console.log('\n✅ Backfill committed successfully.');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Backfill failed — transaction rolled back, no partial changes were made.');
    console.error(err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
