import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const totalResolved = await prisma.ticket.count({ where: { status: 'resolved' } });
  const withResolvedAt = await prisma.ticket.count({ where: { status: 'resolved', resolvedAt: { not: null } } });
  const withoutResolvedAt = await prisma.ticket.count({ where: { status: 'resolved', resolvedAt: null } });
  
  const sampleWithout = await prisma.ticket.findMany({
    where: { status: 'resolved', resolvedAt: null },
    take: 5,
    select: { id: true, channel: true, status: true, receivedAt: true, updatedAt: true }
  });

  console.log(JSON.stringify({ totalResolved, withResolvedAt, withoutResolvedAt, sampleWithout }, null, 2));
}

main().finally(() => prisma.$disconnect());
