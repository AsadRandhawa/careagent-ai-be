/**
 * knowledge.service.js
 * RAG (Retrieval-Augmented Generation) layer for CareAgent
 *
 * Flow:
 *   Upload  → chunkText() → embed() → INSERT into DocumentChunk (pgvector)
 *   Draft   → embed(customerMessage) → similarity search → top-K chunks → inject into prompt
 */

import { prisma }    from '../lib/prisma.js';
import { AIService } from './openai.service.js';

// ── 1. Text chunking ──────────────────────────────────────────────────────────
// Splits text into sentence-aware chunks of ~1500 chars (~375 tokens each).
// Staying well under the 8191-token embed limit.
function chunkText(text, maxChars = 1500) {
  // Split on sentence boundaries
  const sentences = text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?\n])\s+/)
    .filter(s => s.trim().length > 0);

  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += (current ? ' ' : '') + sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Safety: if a single sentence > maxChars, hard-split it
  const result = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChars) {
      result.push(chunk);
    } else {
      for (let i = 0; i < chunk.length; i += maxChars) {
        result.push(chunk.slice(i, i + maxChars));
      }
    }
  }
  return result;
}

// ── 2. Store document chunks ──────────────────────────────────────────────────
// Deletes any previous chunks for this doc, then embeds and stores new ones.
export async function storeDocumentChunks(userId, docName, fullText) {
  // Remove old chunks for this specific doc
  await prisma.$executeRaw`
    DELETE FROM "DocumentChunk"
    WHERE "userId" = ${userId} AND "docName" = ${docName}
  `;

  const chunks = chunkText(fullText);
  let stored = 0;

  for (const chunk of chunks) {
    try {
      const embedding = await AIService.embed(chunk);
      const vectorLiteral = `[${embedding.join(',')}]`;

      await prisma.$executeRaw`
        INSERT INTO "DocumentChunk" ("id", "userId", "docName", "content", "embedding", "createdAt")
        VALUES (
          gen_random_uuid(),
          ${userId},
          ${docName},
          ${chunk},
          ${vectorLiteral}::vector,
          NOW()
        )
      `;
      stored++;
    } catch (err) {
      console.error(`[RAG] Failed to embed chunk ${stored + 1} of "${docName}":`, err.message);
    }
  }

  console.log(`[RAG] Stored ${stored}/${chunks.length} chunks for "${docName}" (user: ${userId})`);
  return stored;
}

// ── 3. Delete all chunks for a user ──────────────────────────────────────────
export async function deleteAllUserChunks(userId) {
  await prisma.$executeRaw`
    DELETE FROM "DocumentChunk" WHERE "userId" = ${userId}
  `;
}

// ── 4. Similarity search ──────────────────────────────────────────────────────
// Embeds the customer query, then returns the top-K most relevant chunks
// using cosine similarity (<=> is pgvector's cosine distance operator).
export async function findRelevantChunks(userId, query, topK = 5) {
  // Check if user has any chunks first
  const count = await prisma.$queryRaw`
    SELECT COUNT(*) as cnt FROM "DocumentChunk" WHERE "userId" = ${userId}
  `;
  if (Number(count[0]?.cnt ?? 0) === 0) return [];

  const embedding  = await AIService.embed(query);
  const vectorLiteral = `[${embedding.join(',')}]`;

  const results = await prisma.$queryRaw`
    SELECT
      "content",
      "docName",
      ROUND(CAST(1 - (embedding <=> ${vectorLiteral}::vector) AS numeric), 4) AS similarity
    FROM "DocumentChunk"
    WHERE "userId" = ${userId}
    ORDER BY embedding <=> ${vectorLiteral}::vector
    LIMIT ${topK}
  `;

  return results; // [{ content, docName, similarity }]
}
