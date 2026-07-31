import { PrismaClient } from '@prisma/client';
import { verifyPassword } from '../src/auth/password';
import { NOKYANG_ADMIN_EMAIL } from './demo-nokyang.fixture';

async function main(): Promise<void> {
  const directUrl = process.env.DIRECT_URL;
  const password = (process.env.NOKYANG_ADMIN_PASSWORD ?? '').trim();

  if (!directUrl) {
    throw new Error(
      'DIRECT_URL must be set for the Nokyang admin drift check.',
    );
  }
  if (!password) {
    throw new Error(
      'NOKYANG_ADMIN_PASSWORD must be set for the Nokyang admin drift check.',
    );
  }

  const prisma = new PrismaClient({ datasources: { db: { url: directUrl } } });
  try {
    const admin = await prisma.user.findUnique({
      where: { email: NOKYANG_ADMIN_EMAIL },
      select: { passwordHash: true },
    });

    if (!admin) {
      throw new Error(
        'Nokyang admin is missing; run the seed before this check.',
      );
    }
    if (
      !admin.passwordHash ||
      !(await verifyPassword(password, admin.passwordHash))
    ) {
      throw new Error(
        'Nokyang admin password drift detected; re-run the seed with the current NOKYANG_ADMIN_PASSWORD.',
      );
    }

    console.log('Nokyang admin password matches NOKYANG_ADMIN_PASSWORD.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : 'Nokyang admin drift check failed.',
  );
  process.exit(1);
});
