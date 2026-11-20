// scripts/migrate-leads-curated-facts.js
//
// One-time migration: ports leads-chatbot's app/curated_facts.py content
// into CareAgent's native DocumentChunk table for a specific user, as
// force-include (triggerPattern) chunks — see the schema.prisma comment
// on DocumentChunk.triggerPattern and the matching logic added to
// findRelevantChunks() in server.js.
//
// These are inserted OUTSIDE the normal reindexKnowledgeBase() path (which
// only rebuilds from the `documents` JSON field), so they survive routine
// Knowledge Base uploads — reindexKnowledgeBase() was updated to only
// delete chunks with triggerPattern IS NULL for exactly this reason.
//
// Run manually, once, against the target account:
//   LEADS_USER_ID=<user-id> node scripts/migrate-leads-curated-facts.js
//
// Safe to re-run: it deletes only its own previously-seeded curated-fact
// chunks for this user (matched by docName prefix) before re-inserting,
// so running it twice does not create duplicates.

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { OpenAI } from 'openai';

const prisma = new PrismaClient();
const openai = new OpenAI({ apiKey: process.env.VITE_OPENAI_API_KEY || process.env.OPENAI_API_KEY });
const EMBEDDING_MODEL = 'text-embedding-3-small';
const DOC_NAME_PREFIX = '[Curated Fact] ';

const userId = process.env.LEADS_USER_ID;
if (!userId) {
  console.error('Set LEADS_USER_ID to the target account\'s User.id before running this script.');
  process.exit(1);
}

// Ported verbatim from app/curated_facts.py — text, url/title, and trigger
// regex per fact. "campus" defaults to "islamabad" (curated_facts.py's own
// default for facts with no explicit campus key) except where the source
// file explicitly tags a fact "university-wide" (the Lahore main-campus
// contact fact).
const CURATED_FACTS = [
  {
    text: 'The Lahore Leads University Islamabad Campus is located at Service Road (South), Near Metro Station G-13, Srinagar Highway, Islamabad — also described as G-12, opposite the G-13 Metro Bus stop.',
    title: 'Islamabad Campus — Address',
    trigger: '\\b(address|location|located|where)\\b',
  },
  {
    text: 'The Islamabad campus contact number, including WhatsApp, is +92 314 4477774. You can also email admissions@leads.edu.pk for admissions queries.',
    title: 'Islamabad Campus — Phone/WhatsApp',
    trigger: '\\b(phone|whatsapp|contact\\s+number|call)\\b',
  },
  {
    text: 'The Campus Director of Lahore Leads University, Islamabad Campus, is Professor Dr Munawar Iqbal Ahmed.',
    title: 'Islamabad Campus — Campus Director',
    trigger: '\\bdirector\\b',
  },
  {
    text: 'The Lahore Leads University Islamabad Campus has officially received HEC (Higher Education Commission) NOC approval.',
    title: 'Islamabad Campus — HEC Approval',
    trigger: '\\b(hec|noc|approv(al|ed))\\b',
  },
  {
    text: 'At the Islamabad campus, the following programs are currently offered:\n\nUndergraduate (BS):\n1) Bachelor in Computer Sciences (BSCS) — with specializations in AI, Data Sciences, Cyber Security, and Software Engineering\n2) Bachelor in Business Administration (BBA) — with specializations in Digital Marketing, Data Analytics, Finance, and Banking\n\nAssociate Degree Program (2 years):\n1) ADP in Computer Sciences\n2) ADP in Business Management\n\nAdditionally, short/prep courses such as IELTS, CA, and ACCA may also be offered.',
    title: 'Islamabad Campus — Programs Offered (Corrected, per official brochure)',
    trigger: '\\b(programs?\\s+offer|what\\s+programs|courses?\\s+offer|engineering|medical|pharmacy|nursing|architecture|law\\b)\\b',
  },
  {
    text: 'The official Islamabad Campus website is https://isb.leads.edu.pk. To apply for admission, use the direct application link: https://apply.leads.edu.pk/registration/iao',
    title: 'Islamabad Campus — Website & Admission Link',
    trigger: '\\b(website|apply|admission\\s+link|portal|register|registration)\\b',
  },
  {
    text: 'A minimum of 50 percent marks in FSC is required for admission to BBA, BS Computer Science, and ADP at the Islamabad campus.',
    title: 'Islamabad Campus — Admission Marks Requirement',
    trigger: '\\b(minimum\\s+marks|marks\\s+requirement|50\\s*%\\s+marks)\\b',
  },
  {
    text: 'BS Computer Science (BSCS) at the Islamabad campus offers specializations in AI, Data Sciences, Cyber Security, and Software Engineering. BBA at the Islamabad campus offers specializations in Digital Marketing, Data Analytics, Finance, and Banking.',
    title: 'Islamabad Campus — Program Specializations',
    trigger: 'specializ|specialis|cializ|cialis',
  },
  {
    text: 'Yes, hostel and transport facilities are available at the Islamabad campus.',
    title: 'Islamabad Campus — Hostel & Transport',
    trigger: '\\b(hostel|transport)\\b',
  },
  {
    text: "Boys Hostel (Munawar Boys Hostel, M.B.H): Contact number 0333-9564736. Address: Old Kashmir Highway, G-12/1, Iqbal Town, Islamabad. It's within walking distance of the Leads Islamabad campus.",
    title: 'Islamabad Campus — Boys Hostel Details',
    trigger: '\\b(hostel|boys?\\s+hostel|male\\s+hostel)\\b',
  },
  {
    text: "Girls Hostel (Munawar Girls Hostel, M.G.H): Contact numbers 0313-9564736, 0303-8190786, or 0333-5751808. Address: Near G-13 Metro Station, SLS School Street No. 2-B, Service Road G-12/1, Islamabad. It's within walking distance of the Leads Islamabad campus. It's a separate, dedicated building with 24/7 security guards and CCTV surveillance, operating since 2016. Rooms are fully furnished (bi-seater, tri-seater, and tetra-seater options), with laundry facilities, nutritious food options, a TV lounge, and study areas. It's also about 5 minutes from the G-13 Metro/NUST Bus Stop, with FAST University Islamabad (H-11/4) and IIUI Girls Campus accessible by university transport or metro.",
    title: 'Islamabad Campus — Girls Hostel Details',
    trigger: '\\b(hostel|girls?\\s+hostel|female\\s+hostel)\\b',
  },
  {
    text: '2nd semester fees at the Islamabad campus (the one-time Admission, Enrollment, and Library fees are only charged in the 1st semester — 2nd semester only has the recurring per-semester charges): BS Computer Science (BSCS): Tuition Fee 120,000 PKR + Examination Fee 5,000 PKR = 125,000 PKR total for the 2nd semester. BBA: Tuition Fee 100,000 PKR + Examination Fee 5,000 PKR = 105,000 PKR total for the 2nd semester. ADP (Business Administration / Computer Science): Tuition Fee 65,000 PKR + Examination Fee 5,000 PKR = 70,000 PKR total for the 2nd semester.',
    title: 'Islamabad Campus — 2nd Semester Fee Structure',
    trigger: '\\b(2nd\\s+semester|second\\s+semester)\\b',
  },
  {
    text: 'Scholarship eligibility is based on a student\'s aggregate. There are two cases: (1) If a student has NOT yet received their Intermediate SECOND YEAR result (common for recently-examined students still awaiting results), aggregate is calculated PROVISIONALLY as Matric % + Intermediate FIRST YEAR % only. (2) If a student HAS already received their complete Intermediate (FSc/ICS) result — both years — aggregate is calculated as Matric % + the COMPLETE Intermediate percentage (both years combined), NOT just the first year. Always ask a student whether they have their full/complete Intermediate result yet before deciding which calculation applies.',
    title: 'Islamabad Campus — Aggregate Calculation Formula',
    trigger: '\\b(aggregate|merit\\s+scholarship)\\b',
  },
  {
    text: "Merit scholarship: if a student's aggregate is 85% or above, they are offered a 75% discount on the tuition fee. (See the Aggregate Calculation Formula fact for how the aggregate itself is calculated, which depends on whether the student has their complete Intermediate result yet.)",
    title: 'Islamabad Campus — Merit Scholarship (85%+ Aggregate = 75% Tuition Discount)',
    trigger: '\\b(aggregate|merit\\s+scholarship|85\\s*%)\\b|\\bfee\\b|\\btuition\\b|schola|scolar|\\bdiscount\\b',
  },
  {
    text: 'Need/circumstance-based discount: students who belong to a needy financial background, or who apply for early admission, are offered a 25% waiver on the tuition fee. The early-admission portion of this offer is time-limited to applications submitted before 10th September (extended deadline, for the current intake). NOTE: this 25% tier is for needy background / early admission only — orphan students get a DIFFERENT, higher discount (see the separate Orphan Discount fact).',
    title: 'Islamabad Campus — Need-Based / Early-Admission Discount (25% Tuition)',
    trigger: '\\b(needy|early\\s+admission|financial\\s+need|25\\s*%)\\b|\\bfee\\b|\\btuition\\b|schola|scolar|\\bdiscount\\b',
  },
  {
    text: 'Orphan students are offered a 50% discount on the tuition fee. Note: this is a different tier from the need-based discount (25%) and the merit scholarship (85%+ aggregate = 75%) — orphan status alone gives 50%, not 25% and not 75%. If a student qualifies for orphan status AND also has an 85%+ aggregate, the merit scholarship (75%) is the larger discount and is the one that applies — never assume orphan status is automatically the best tier without comparing the actual percentages.',
    title: 'Islamabad Campus — Orphan Discount (50% Tuition)',
    trigger: '\\borphan\\b|\\bfee\\b|\\btuition\\b|schola|scolar|\\bdiscount\\b',
  },
  {
    text: 'Students from FATA (Federally Administered Tribal Areas) and other Balochistan cities can avail a 50% discount on fees based on financial need.',
    title: 'Islamabad Campus — FATA & Balochistan Need-Based Discount (50%)',
    trigger: '\\b(fata|balochistan|baloch)\\b|\\bfee\\b|\\btuition\\b|schola|scolar|\\bdiscount\\b',
  },
  {
    text: "If a student's Matric aggregate component is 50% or above but their PROVISIONAL aggregate (using Intermediate FIRST YEAR only) looks low because their first year marks were below 50% (for example 47%), first check: has the student already received their COMPLETE Intermediate (both years) result? If yes, recalculate their aggregate using Matric % + the COMPLETE Intermediate % instead of first-year-only — this may put them in a completely different, better eligibility bracket. If they've appeared in second-year exams but do NOT have the result yet, do not tell them they are ineligible — advise them to submit their documents and apply so the admissions team can reassess once the complete result is available.",
    title: 'Islamabad Campus — Below-50% First-Year, Second-Year-Appeared Case',
    trigger: '\\b(aggregate|first\\s+year|1st\\s+year|second\\s+year|eligib)\\b',
  },
  {
    text: 'If a student\'s original documents (such as the Matric or Intermediate marksheet, or any other required document) are missing, a photocopy of that document can also be accepted for the admission process.',
    title: 'Islamabad Campus — Missing Original Documents Policy',
    trigger: '\\b(document|documents|marksheet|original|photocopy|missing|copy)\\b',
  },
  {
    text: 'Students from a pre-medical background are also eligible for admission into Computer Science programs (BS Computer Science, ADP Computer Science) at the Islamabad campus. They follow the exact same admission process as all other students — no separate or additional requirement applies just because their background is pre-medical rather than pre-engineering/computer science.',
    title: 'Islamabad Campus — Pre-Medical Students Eligible for Computer Science',
    trigger: '\\bpre-?medical\\b',
  },
  {
    text: 'Currently, no admission test is required to get admission at the Islamabad campus. Admission decisions are based solely on the student\'s Matric and Intermediate aggregate (see the Aggregate Calculation Formula fact for how that\'s calculated) — there is no separate entry/admission test for undergraduate programs like BS Computer Science, ADP, or BBA right now. HOWEVER: this is tied to Early Bird admission — seats with guaranteed scholarships are limited and are being filled on a rolling basis. Once those Early Bird seats are filled, future applicants may be required to appear for a mandatory entrance test instead, with admission decided by the test merit list. Students should be encouraged to apply promptly to secure a no-test Early Bird seat with a guaranteed scholarship while it\'s still available.',
    title: 'Islamabad Campus — No Admission Test Required (Currently, Early Bird)',
    trigger: '\\b(admission\\s+test|entry\\s+test|entrance\\s+test)\\b',
  },
  {
    text: 'Early Bird admission seats with guaranteed scholarships are limited and are being filled on a rolling basis. Students are encouraged to apply as soon as possible to secure an Early Bird seat and lock in a guaranteed scholarship without needing to take an entrance test. Once Early Bird seats are filled, subsequent applicants may be required to appear for a mandatory entrance test, with admission decided based on the test merit list instead of the usual aggregate-based process.',
    title: 'Islamabad Campus — Early Bird Seats Limited, Apply Promptly',
    trigger: '\\b(early\\s+bird|seats?\\s+fill|hurry|apply\\s+(soon|quickly|now)|guaranteed\\s+scholarship)\\b',
  },
  {
    text: 'Lahore Leads University Islamabad Campus combines modern interactive education with complete cultural respect: male and female students share the same academic programs and classes, preparing them for professional, real-world environments. Classrooms feature organized, separate row arrangements for male and female students to maintain focus, modesty, and mutual respect.',
    title: 'Islamabad Campus — Co-Education & Classroom Arrangement',
    trigger: '\\b(co-?education|coed|separate\\s+class|gender\\s+segregat|boys?\\s+only|girls?\\s+only|male\\s+and\\s+female|mixed\\s+class|seating)\\b',
  },
  {
    text: 'Buying a degree without genuinely completing the required coursework and attending as a real, enrolled student is NOT permitted — Lahore Leads University does not sell degrees. Similarly, obtaining a degree entirely from abroad without ever physically attending or enrolling as a proper student is NOT permitted — there is no remote-only or attendance-free degree option for students who wish to stay in their home country while avoiding actual study or enrollment. All students, including international/overseas applicants who genuinely want to study, must go through the standard admission process and actually attend/study.',
    title: 'Islamabad Campus — Academic Integrity (No Degree Buying / No Remote-Only Degrees)',
    trigger: '\\b(buy\\s+(a\\s+)?degree|purchase\\s+(a\\s+)?degree|degree\\s+without\\s+(attending|studying|coming)|without\\s+attending|sitting\\s+(there|abroad|at\\s+home)|from\\s+abroad\\s+without|no\\s+need\\s+to\\s+attend)\\b',
  },
  {
    text: 'BS Computer Science (BSCS) at the Islamabad campus — full 1st semester fee breakdown: Admission Fee (once) 10,000 PKR, Enrollment Fee 10,000 PKR, Tuition Fee (per semester) 120,000 PKR, Examination Fee (per semester) 5,000 PKR, Library Fee (once) 5,000 PKR. Total for the 1st semester: 150,000 PKR. (Consistent with the separate 2nd Semester Fee Structure fact, which correctly drops the one-time Admission/Enrollment/Library fees, leaving Tuition 120,000 + Examination 5,000 = 125,000 for the 2nd semester.) IMPORTANT: BS Computer Science is offered with specializations in AI, Data Science, Cyber Security, and Software Engineering (per the official Fall 2026 admissions flyer) — these are NOT separate programs with their own fees. A student asking about "BS Data Science", "BS Cybersecurity", "BS Software Engineering", "BS AI", or similar specialization names is asking about THIS SAME BSCS program and pays this exact same fee — never say fee information for a specialization "is not available."',
    title: 'Islamabad Campus — BSCS 1st Semester Full Fee Breakdown (covers all specializations: AI, Data Science, Cyber Security, Software Engineering)',
    trigger: '\\b(bscs|bs\\s*cs|bs\\s*computer\\s*science|bs\\s*data\\s*science|bs\\s*cyber\\s*?security|bs\\s*software\\s*engineering|bs\\s*(in\\s*)?ai\\b|data\\s*science|cyber\\s*?security|software\\s*engineering)\\b',
  },
  {
    text: 'BBA (Bachelor of Business Administration) at the Islamabad campus — full 1st semester fee breakdown: Admission Fee (once) 10,000 PKR, Enrollment Fee 10,000 PKR, Tuition Fee (per semester) 100,000 PKR, Examination Fee (per semester) 5,000 PKR, Library Fee (once) 5,000 PKR. Total for the 1st semester: 130,000 PKR. (Consistent with the separate 2nd Semester Fee Structure fact, which correctly drops the one-time Admission/Enrollment/Library fees, leaving Tuition 100,000 + Examination 5,000 = 105,000 for the 2nd semester.) IMPORTANT: BBA is offered with specializations in Finance, Data Analytics, Banking, and Digital Marketing (per the official Fall 2026 admissions flyer) — these are NOT separate programs with their own fees. A student asking about "BBA Finance", "BBA Data Analytics", "BBA Banking", "BBA Digital Marketing", or similar specialization names is asking about THIS SAME BBA program and pays this exact same fee.',
    title: 'Islamabad Campus — BBA 1st Semester Full Fee Breakdown (covers all specializations: Finance, Data Analytics, Banking, Digital Marketing)',
    trigger: '\\bbba\\b|business\\s*administration|\\bfinance\\b|data\\s*analytics|\\bbanking\\b|digital\\s*marketing',
  },
  {
    text: 'ADP (Associate Degree Program — both Computer Science and Business Administration variants) at the Islamabad campus — full 1st semester fee breakdown: Admission Fee (once) 10,000 PKR, Enrollment Fee 10,000 PKR, Tuition Fee (per semester) 65,000 PKR, Examination Fee (per semester) 5,000 PKR, Library Fee (once) 5,000 PKR. Total for the 1st semester: 95,000 PKR. (Consistent with the separate 2nd Semester Fee Structure fact, which correctly drops the one-time Admission/Enrollment/Library fees, leaving Tuition 65,000 + Examination 5,000 = 70,000 for the 2nd semester.)',
    title: 'Islamabad Campus — ADP 1st Semester Full Fee Breakdown',
    trigger: '\\badp\\b',
  },
  {
    text: 'Lahore Main Campus contact details: Lahore Leads University, DHA Phase V, Kamahan Road, Lahore, Pakistan. Phone: 042-35927-411, 042-35927-413, 042-35927-415, or 0304-1111-552. Email: admissions@leads.edu.pk.',
    title: 'Lahore Main Campus — Contact Details',
    campus: 'university-wide',
    trigger: '\\blahore\\b|\\bmain\\s+campus\\b|\\bengineering\\b|\\bmedical\\b|\\bpharmacy\\b|\\bnursing\\b|\\barchitecture\\b',
  },
  {
    text: 'To continue receiving any scholarship or fee discount/waiver at the Islamabad campus — whether it\'s the merit scholarship, need-based waiver, orphan discount, or the FATA/Balochistan discount — a student must maintain a minimum CGPA of 3.0. Falling below a 3.0 CGPA may result in losing the scholarship.',
    title: 'Islamabad Campus — Scholarship Maintenance Requirement (3.0 CGPA)',
    trigger: '\\bcgpa\\b|\\bgpa\\b|maintain|keep\\s+(my|the|a)\\s+scholarship|minimum\\s+grade',
  },
];

async function embedText(text) {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8000),
  });
  return response.data[0].embedding;
}

async function main() {
  console.log(`Migrating ${CURATED_FACTS.length} curated facts for user ${userId}...`);

  // Re-runnable: clear only this script's own previously-seeded rows
  // (by docName prefix), never touching ordinary KB chunks or other
  // curated-fact chunks from a different source.
  const deleted = await prisma.$executeRaw`
    DELETE FROM "DocumentChunk"
    WHERE "userId" = ${userId} AND "docName" LIKE ${DOC_NAME_PREFIX + '%'}
  `;
  console.log(`Cleared ${deleted} previously-seeded curated-fact chunks.`);

  let stored = 0, failed = 0;
  for (const fact of CURATED_FACTS) {
    try {
      const campus = fact.campus || 'islamabad';
      // Campus tag folded into docName so it survives into the
      // "[from "docName", relevance N]" format findRelevantChunks() already
      // uses — the ported prompt addendum instructs the model to read this
      // tag for campus-scoping, matching rag.py's [Campus: ...] convention.
      const docName = `${DOC_NAME_PREFIX}${fact.title} [Campus: ${campus}]`;
      const embedding = await embedText(fact.text);
      const vectorLiteral = `[${embedding.join(',')}]`;
      await prisma.$executeRaw`
        INSERT INTO "DocumentChunk" ("id", "userId", "docName", "content", "embedding", "triggerPattern", "createdAt")
        VALUES (gen_random_uuid(), ${userId}, ${docName}, ${fact.text}, ${vectorLiteral}::vector, ${fact.trigger}, NOW())
      `;
      stored++;
      console.log(`  ✓ ${fact.title}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${fact.title}:`, err.message);
    }
  }

  console.log(`\nDone: ${stored} stored, ${failed} failed.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Migration failed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
