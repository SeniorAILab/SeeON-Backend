import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ClipStorageReference } from './clip-storage.types.js';

@Injectable()
export class ClipStorageReferenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listAll(): Promise<readonly ClipStorageReference[]> {
    const facilities = await this.prisma.db.facility.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const references: ClipStorageReference[] = [];
    for (const facility of facilities) {
      const facilityReferences = await this.prisma.withFacilityContext(
        facility.id,
        async (tx) => {
          const clips = await tx.mediaClip.findMany({
            where: { storageKey: { not: null } },
            select: { storageKey: true, sha256: true, byteSize: true },
            orderBy: { storageKey: 'asc' },
          });
          return clips.map(toStorageReference);
        },
      );
      references.push(...facilityReferences);
    }
    return references;
  }
}

function toStorageReference(row: {
  readonly storageKey: string | null;
  readonly sha256: string | null;
  readonly byteSize: bigint | null;
}): ClipStorageReference {
  if (
    row.storageKey === null ||
    row.sha256 === null ||
    row.byteSize === null ||
    row.byteSize > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new ClipStorageReferenceError(row.storageKey);
  }
  return {
    storageKey: row.storageKey,
    sha256: row.sha256,
    sizeBytes: Number(row.byteSize),
  };
}

export class ClipStorageReferenceError extends Error {
  readonly name = 'ClipStorageReferenceError';

  constructor(readonly storageKey: string | null) {
    super('stored clip reference is incomplete or exceeds safe integer range');
  }
}
