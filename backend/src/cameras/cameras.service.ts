import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { Prisma } from '@prisma/client';
import type { Camera } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CreateCameraRequestDto,
  UpdateCameraRequestDto,
} from './dto/camera.dto.js';

@Injectable()
export class CamerasService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveForEventIngest(
    cameraId: string,
  ): Promise<{ id: string; facilityId: string; spaceId: string; ingestMode: 'LEGACY_ALERTS' | 'EVENT_API' }> {
    const rows = await this.prisma.$queryRaw<
      { id: string; facilityId: string; spaceId: string; ingestMode: 'LEGACY_ALERTS' | 'EVENT_API' }[]
    >`SELECT id, facility_id AS "facilityId", space_id AS "spaceId", ingest_mode AS "ingestMode"
       FROM get_camera_for_event_ingest(${cameraId})`;

    const camera = rows[0];
    if (!camera) throw new NotFoundException('unknown_camera');

    return camera;
  }

  async list(facilityId: string) {
    const cameras = await this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) =>
        tx.camera.findMany({ orderBy: { createdAt: 'asc' } }),
    );
    return cameras.map(toCameraDto);
  }

  async getOne(facilityId: string, id: string) {
    const cam = await this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) => tx.camera.findUnique({ where: { id } }),
    );
    if (!cam) throw new NotFoundException('Camera not found');
    return toCameraDto(cam);
  }

  async create(facilityId: string, dto: CreateCameraRequestDto) {
    if (!dto.label.trim()) throw new ConflictException('label is required');
    if (!dto.spaceId.trim()) throw new ConflictException('spaceId is required');
    const ingestKeyId = `cam-${crypto.randomBytes(8).toString('hex')}`;
    const ingestSecret = crypto.randomBytes(24).toString('hex');
    const ingestSecretHash = sha256(ingestSecret);
    try {
      const camera = await this.prisma.withFacilityContext(
        facilityId,
        (tx: Prisma.TransactionClient) =>
          tx.camera.create({
            data: {
              facilityId,
              label: dto.label.trim(),
              spaceId: dto.spaceId,
              ingestKeyId,
              ingestSecretHash,
            },
          }),
      );
      return { ...toCameraDto(camera), ingestSecret };
    } catch (err: unknown) {
      throwCameraWriteConflict(err);
    }
  }

  async update(facilityId: string, id: string, dto: UpdateCameraRequestDto) {
    const existing = await this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) => tx.camera.findUnique({ where: { id } }),
    );
    if (!existing) throw new NotFoundException('Camera not found');
    if (dto.label !== undefined && !dto.label.trim()) {
      throw new ConflictException('label is required');
    }
    if (
      dto.spaceId !== undefined &&
      (typeof dto.spaceId !== 'string' || !dto.spaceId.trim())
    ) {
      throw new ConflictException('spaceId is required');
    }
    try {
      const camera = await this.prisma.withFacilityContext(
        facilityId,
        (tx: Prisma.TransactionClient) =>
          tx.camera.update({
            where: { id },
            data: {
              label: dto.label?.trim(),
              spaceId:
                dto.spaceId === undefined ? undefined : dto.spaceId.trim(),
            },
          }),
      );
      return toCameraDto(camera);
    } catch (err: unknown) {
      throwCameraWriteConflict(err);
    }
  }

  async remove(facilityId: string, id: string) {
    const existing = await this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) => tx.camera.findUnique({ where: { id } }),
    );
    if (!existing) throw new NotFoundException('Camera not found');
    try {
      const camera = await this.prisma.withFacilityContext(
        facilityId,
        (tx: Prisma.TransactionClient) => tx.camera.delete({ where: { id } }),
      );
      return toCameraDto(camera);
    } catch (err: unknown) {
      if (isReferenceConstraintError(err)) {
        throw new ConflictException(
          'Camera cannot be deleted while alerts or status rows reference it',
        );
      }
      throw err;
    }
  }

  async recordHeartbeat(facilityId: string, cameraId: string) {
    const now = new Date();
    await this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) =>
        tx.camera.update({
          where: { id: cameraId },
          data: { lastSeenAt: now, online: true },
        }),
    );
  }
}

function toCameraDto(camera: Camera) {
  return {
    id: camera.id,
    facilityId: camera.facilityId,
    spaceId: camera.spaceId,
    label: camera.label,
    ingestKeyId: camera.ingestKeyId,
    lastSeenAt: camera.lastSeenAt,
    online: camera.online,
    ingestMode: camera.ingestMode,
    createdAt: camera.createdAt,
  };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function throwCameraWriteConflict(err: unknown): never {
  if (isUniqueConstraintError(err)) {
    throw new ConflictException(
      'Camera label, ingest key, or space already exists',
    );
  }
  if (isReferenceConstraintError(err)) {
    throw new ConflictException('Camera space must belong to the facility');
  }
  throw err;
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

function isReferenceConstraintError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    (err.code === 'P2003' || err.code === 'P2014')
  );
}
