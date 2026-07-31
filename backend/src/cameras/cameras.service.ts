import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Camera } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { bumpMlConfigVersion } from '../ml-config/ml-config.version.js';
import type {
  CreateCameraRequestDto,
  EdgeCameraMappingRequestDto,
  EdgeCameraMappingResponseDto,
  UpdateCameraRequestDto,
} from './dto/camera.dto.js';

@Injectable()
export class CamerasService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveForEventIngest(
    cameraId: string,
  ): Promise<{ id: string; facilityId: string; spaceId: string }> {
    const rows = await this.prisma.$queryRaw<
      { id: string; facilityId: string; spaceId: string }[]
    >`SELECT id, facility_id AS "facilityId", space_id AS "spaceId"
       FROM get_camera_for_event_ingest(${cameraId})`;

    const camera = rows.at(0);
    if (camera === undefined) throw new NotFoundException('unknown_camera');

    return camera;
  }

  async upsertEdgeCameraMapping(
    facilityId: string,
    dto: EdgeCameraMappingRequestDto,
  ): Promise<EdgeCameraMappingResponseDto> {
    requireNonBlankString(dto.edge_camera_ref, 'edge_camera_ref');
    const label = requireNonBlankString(dto.label, 'label');
    const spaceId = requireNonBlankString(dto.spaceId, 'spaceId');

    try {
      const camera = await this.prisma.withFacilityContext(
        facilityId,
        async (tx: Prisma.TransactionClient) => {
          const camera = await tx.camera.upsert({
            where: { facilityId_spaceId: { facilityId, spaceId } },
            create: { facilityId, label, spaceId },
            update: { label },
          });
          await bumpMlConfigVersion(tx, facilityId);
          return camera;
        },
      );
      return {
        cameraId: camera.id,
        facilityId: camera.facilityId,
        spaceId: camera.spaceId,
      };
    } catch (err: unknown) {
      throwCameraWriteConflict(err);
    }
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
    try {
      const camera = await this.prisma.withFacilityContext(
        facilityId,
        async (tx: Prisma.TransactionClient) => {
          const camera = await tx.camera.create({
            data: {
              facilityId,
              label: dto.label.trim(),
              spaceId: dto.spaceId,
              rtspUrl: dto.rtspUrl,
            },
          });
          await bumpMlConfigVersion(tx, facilityId);
          return camera;
        },
      );
      return toCameraDto(camera);
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
        async (tx: Prisma.TransactionClient) => {
          const camera = await tx.camera.update({
            where: { id },
            data: {
              label: dto.label?.trim(),
              spaceId:
                dto.spaceId === undefined ? undefined : dto.spaceId.trim(),
              rtspUrl: dto.rtspUrl,
            },
          });
          await bumpMlConfigVersion(tx, facilityId);
          return camera;
        },
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
        async (tx: Prisma.TransactionClient) => {
          const camera = await tx.camera.delete({ where: { id } });
          await bumpMlConfigVersion(tx, facilityId);
          return camera;
        },
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
  async recordOffline(facilityId: string, cameraId: string) {
    await this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) =>
        tx.camera.update({
          where: { id: cameraId },
          data: { online: false },
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
    lastSeenAt: camera.lastSeenAt,
    online: camera.online,
    createdAt: camera.createdAt,
  };
}

function requireNonBlankString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConflictException(`${field} is required`);
  }
  return value.trim();
}

function throwCameraWriteConflict(err: unknown): never {
  if (isUniqueConstraintError(err)) {
    throw new ConflictException('Camera label or space already exists');
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
