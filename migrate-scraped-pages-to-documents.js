// migrate-scraped-pages-to-documents.js
//
// FIXES A REAL GAP: the original migrate-leads-scraped-pages.js inserted
// scraped-page content directly into DocumentChunk, bypassing the
// User.documents field entirely. reindexKnowledgeBase() (used by every
// normal Knowledge Base upload) only PRESERVES chunks with a
// triggerPattern set (curated facts) — everything else gets deleted and
// rebuilt from `documents`. Since the scraped pages were never part of
// `documents`, the next real KB upload would have silently deleted all
// 312 scraped-page chunks.
//
// This script fixes that by calling the REAL /api/user/knowledge-base
// endpoint (same one the UI uses) with the scraped-page content packaged
// as normal documents — going forward, they're indistinguishable from
// anything uploaded through the UI, safe from being wiped, and chunked/
// embedded via the exact same code path as everything else.
//
// Reuses the same content-safety filtering already built (URL exclusions,
// the conflicting-fee-widget fingerprint, spam redaction) — this is NOT
// a raw re-upload of the scrape, it's the same vetted content.
//
// NOTE: this OVERWRITES User.documents. Confirmed empty ([]) for this
// account via direct SQL before writing this script — if that's changed
// since, check first (`SELECT documents FROM "User" WHERE id = ...`)
// before running, since this does not attempt to merge.
//
// Usage:
//   node migrate-scraped-pages-to-documents.js "<jwt-token>" "E:\leads-islamabad-chatbot-main\data\raw"

const BASE_URL = process.env.BASE_URL || 'https://careagent-ai-be-production.up.railway.app';
const token = process.argv[2];
const rawDir = process.argv[3];

if (!token || !rawDir) {
  console.error('Usage: node migrate-scraped-pages-to-documents.js "<jwt-token>" "<path-to-data-raw>"');
  process.exit(1);
}

import fs from 'fs';
import path from 'path';

// ── Same filtering logic as migrate-leads-scraped-pages.js ────────────────
const EXCLUDE_URL_OR_TITLE = (url, title) => {
  const u = url.toLowerCase(), t = title.toLowerCase();
  return (
    u.includes('allied-health') || t.includes('allied health') ||
    u.includes('our-programs') || u.includes('academic-department') ||
    t === 'our programs - leads university' || t === 'academic department' ||
    u.includes('honhaar') || t.includes('honhaar') ||
    u === 'https://leads.edu.pk/tuition-fees/' ||
    u === 'https://leads.edu.pk/admission/'
  );
};
const CONFLICTING_FEE_WIDGET_RE = /tution fee per semester/i;
const SPAM_RE = new RegExp(['casino', 'betting', '\\bbonus code\\b', 'free spins', 'gambl'].join('|'), 'i');

function cleanMarkdown(md) {
  const lines = md.split('\n').filter(ln => ln.trim().length > 3);
  let text = lines.join('\n');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function redactSpamSentences(text) {
  if (!SPAM_RE.test(text)) return text;
  const pieces = text.split(/(?<=[.\n])/);
  return pieces.filter(p => !SPAM_RE.test(p)).join('').trim();
}

async function main() {
  const files = fs.readdirSync(rawDir).filter(f => f.endsWith('.json'));
  console.log(`Found ${files.length} raw scraped pages.`);

  const documents = [];
  let excludedByUrl = 0, excludedByWidget = 0;

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf-8'));
    if (EXCLUDE_URL_OR_TITLE(data.url, data.title)) { excludedByUrl++; continue; }

    let cleaned = cleanMarkdown(data.markdown);
    if (CONFLICTING_FEE_WIDGET_RE.test(cleaned)) { excludedByWidget++; continue; }
    cleaned = redactSpamSentences(cleaned);

    if (cleaned.length < 40) continue; // skip empty/near-empty pages

    documents.push({ name: data.title, textContent: cleaned });
  }

  console.log(`Prepared ${documents.length} documents (${excludedByUrl} excluded by URL, ${excludedByWidget} excluded by conflicting-widget fingerprint).`);

  console.log('Uploading via /api/user/knowledge-base (same endpoint the UI uses)...');
  const res = await fetch(`${BASE_URL}/api/user/knowledge-base`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ documents }),
  });

  if (!res.ok) {
    console.error(`Failed: HTTP ${res.status}`, await res.text().catch(() => ''));
    process.exit(1);
  }
  const result = await res.json();
  console.log('Done:', JSON.stringify(result, null, 2));
  console.log('\nThis content is now part of User.documents — safe from being wiped by future normal Knowledge Base uploads, and chunked/embedded via the same standard pipeline as anything uploaded through the UI.');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
