// scripts/migrate-leads-scraped-pages.js
//
// Ports leads-chatbot's ingest/build_index.py 1:1 — same spam patterns,
// same page exclusions (allied-health / our-programs / academic-department
// / honhaar), same heading-aware chunking, same campus-tagging heuristic —
// but writes to CareAgent's native DocumentChunk instead of Chroma.
//
// Does NOT touch curated facts (see migrate-leads-curated-facts.js,
// already run separately) — only the raw scraped page content.
//
// Prerequisite: run `python ingest/scrape.py` on the leads-chatbot side
// first (needs FIRECRAWL_API_KEY + network access this sandbox doesn't
// have), then point RAW_DIR below at the resulting data/raw/ folder —
// or set RAW_DIR env var.
//
// Usage:
//   LEADS_USER_ID=<user-id> RAW_DIR=/path/to/data/raw node scripts/migrate-leads-scraped-pages.js

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { OpenAI } from 'openai';

const prisma = new PrismaClient();
const openai = new OpenAI({ apiKey: process.env.VITE_OPENAI_API_KEY || process.env.OPENAI_API_KEY });
const EMBEDDING_MODEL = 'text-embedding-3-small';
const DOC_NAME_PREFIX = '[Scraped Page] ';

const userId = process.env.LEADS_USER_ID;
const RAW_DIR = process.env.RAW_DIR || path.resolve('./data/raw');
if (!userId) {
  console.error('Set LEADS_USER_ID to the target account\'s User.id before running this script.');
  process.exit(1);
}
if (!fs.existsSync(RAW_DIR)) {
  console.error(`RAW_DIR not found: ${RAW_DIR} — run scrape.py first and point RAW_DIR at its data/raw/ output.`);
  process.exit(1);
}

// ── Ported from build_index.py ──────────────────────────────────────────
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 120;
const MIN_CHUNK_LEN = 40;
const HEADING_RE = /^#{1,6}\s+.*$/gm;
const SPAM_PATTERNS = ['casino', 'betting', '\\bbonus code\\b', 'free spins', 'gambl'];
const SPAM_RE = new RegExp(SPAM_PATTERNS.join('|'), 'i');

// Defense-in-depth beyond the URL exclusions above: this exact string
// ("Tution Fee Per Semester" — note the source site's own typo) is a
// reliable fingerprint of the conflicting general/university-wide
// fee-comparison widget, confirmed to appear on two different URLs
// already. If a future re-scrape surfaces it on a THIRD, currently-
// unknown page, this catches it automatically instead of requiring
// another live-bug discovery first. Whole chunk is dropped (not
// redacted) since a fee-comparison-table chunk has no salvageable
// content once the risky part is removed.
const CONFLICTING_FEE_WIDGET_RE = /tution fee per semester/i;

const EXCLUDE_URL_OR_TITLE = (url, title) => {
  const u = url.toLowerCase(), t = title.toLowerCase();
  return (
    u.includes('allied-health') || t.includes('allied health') ||
    u.includes('our-programs') || u.includes('academic-department') ||
    t === 'our programs - leads university' || t === 'academic department' ||
    u.includes('honhaar') || t.includes('honhaar') ||
    // General/university-wide fee-comparison widget — confirmed to appear
    // verbatim on BOTH these URLs (same "Tution Fee Per Semester" table,
    // note the source site's own typo — a reliable fingerprint), listing
    // conflicting numbers for the same program names against Islamabad's
    // own verified program-page fee tables (e.g. BSCS 150,000/semester
    // here vs. 120,000/semester on Islamabad's own page; Doctor of
    // Pharmacy — a program Islamabad doesn't even offer — also lives in
    // this same table and was mistakenly surfaced for an Islamabad fee
    // question once already). admission-procedure.json and
    // admission-guideline.json already cover genuine admission-process
    // content cleanly, without this widget.
    u === 'https://leads.edu.pk/tuition-fees/' ||
    u === 'https://leads.edu.pk/admission/'
  );
};

function cleanMarkdown(md) {
  const lines = md.split('\n').filter(ln => ln.trim().length > 3);
  let text = lines.join('\n');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');           // strip images
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');        // collapse links to visible text
  text = text.replace(/\n{3,}/g, '\n\n');                     // collapse blank lines
  return text.trim();
}

function redactSpam(chunk) {
  if (!SPAM_RE.test(chunk)) return { cleaned: chunk, wasRedacted: false };
  const pieces = chunk.split(/(?<=[.\n])/);
  const kept = pieces.filter(p => !SPAM_RE.test(p));
  return { cleaned: kept.join('').trim(), wasRedacted: true };
}

function splitIntoSections(text) {
  const matches = [...text.matchAll(HEADING_RE)];
  if (matches.length === 0) return [[null, text]];

  const sections = [];
  if (matches[0].index > 0) sections.push([null, text.slice(0, matches[0].index)]);
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const heading = matches[i][0].trim();
    sections.push([heading, text.slice(start, end).trim()]);
  }
  return sections;
}

function chunkSection(heading, sectionText, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (sectionText.length <= size) return [sectionText];
  const chunks = [];
  let start = 0;
  while (start < sectionText.length) {
    let piece = sectionText.slice(start, start + size).trim();
    if (piece) {
      if (heading && !piece.startsWith(heading)) piece = `${heading}\n${piece}`;
      chunks.push(piece);
    }
    start += size - overlap;
  }
  return chunks;
}

function buildChunks(cleanedText, pageTitle) {
  const chunks = [];
  for (const [heading, sectionText] of splitIntoSections(cleanedText)) {
    if (!sectionText.trim()) continue;
    for (const piece of chunkSection(heading, sectionText)) {
      chunks.push(`Page: ${pageTitle}\n${piece}`.trim());
    }
  }
  return chunks;
}
// ── End port ─────────────────────────────────────────────────────────────

async function embedText(text) {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8000),
  });
  return response.data[0].embedding;
}

async function main() {
  const files = fs.readdirSync(RAW_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.error(`No .json files found in ${RAW_DIR}.`);
    process.exit(1);
  }
  console.log(`Found ${files.length} raw scraped pages in ${RAW_DIR}.`);

  // Re-runnable, same pattern as the curated-facts script: clear only this
  // script's own previously-seeded rows before re-inserting.
  const deleted = await prisma.$executeRaw`
    DELETE FROM "DocumentChunk"
    WHERE "userId" = ${userId} AND "docName" LIKE ${DOC_NAME_PREFIX + '%'}
  `;
  console.log(`Cleared ${deleted} previously-seeded scraped-page chunks.`);

  let stored = 0, failed = 0, redactedCount = 0, droppedCount = 0, conflictingWidgetCount = 0, pageCount = 0;

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(RAW_DIR, file), 'utf-8'));
    if (EXCLUDE_URL_OR_TITLE(data.url, data.title)) continue;

    const cleaned = cleanMarkdown(data.markdown);
    pageCount++;
    const urlOrTitleIslamabad = data.url.toLowerCase().includes('islamabad') || data.title.toLowerCase().includes('islamabad');

    const rawChunks = buildChunks(cleaned, data.title);
    for (let i = 0; i < rawChunks.length; i++) {
      if (CONFLICTING_FEE_WIDGET_RE.test(rawChunks[i])) {
        conflictingWidgetCount++;
        console.log(`  ⚠ Dropped chunk ${i} of "${data.title}" (${data.url}) — matched conflicting fee-widget fingerprint.`);
        continue;
      }
      const { cleaned: chunkText, wasRedacted } = redactSpam(rawChunks[i]);
      if (wasRedacted) redactedCount++;
      if (chunkText.length < MIN_CHUNK_LEN) { droppedCount++; continue; }

      const isIslamabad = urlOrTitleIslamabad || chunkText.toLowerCase().includes('islamabad');
      const campus = isIslamabad ? 'islamabad' : 'university-wide';
      const docName = `${DOC_NAME_PREFIX}${data.title} [Campus: ${campus}]`;

      try {
        const embedding = await embedText(chunkText);
        const vectorLiteral = `[${embedding.join(',')}]`;
        await prisma.$executeRaw`
          INSERT INTO "DocumentChunk" ("id", "userId", "docName", "content", "embedding", "createdAt")
          VALUES (gen_random_uuid(), ${userId}, ${docName}, ${chunkText}, ${vectorLiteral}::vector, NOW())
        `;
        stored++;
      } catch (err) {
        failed++;
        console.error(`  ✗ chunk ${i} of "${data.title}":`, err.message);
      }
    }
  }

  console.log(`\nIndexed ${stored} chunks from ${pageCount} pages (${failed} failed).`);
  if (redactedCount) console.log(`Redacted spam sentences from ${redactedCount} chunks.`);
  if (droppedCount) console.log(`Dropped ${droppedCount} chunks that were empty/too short after cleaning.`);
  if (conflictingWidgetCount) console.log(`Dropped ${conflictingWidgetCount} chunks matching the conflicting fee-widget fingerprint.`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Migration failed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
