import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  MlConfigResponseDto,
  UpdateNightWindowRequestDto,
} from './dto/ml-config.dto.js';

const DEFAULT_NIGHT_WINDOW = {
  start: '21:00',
  end: '07:00',
  tz: 'Asia/Seoul',
};
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
type CameraLocation = {
  name: string;
  floor: { name: string } | null;
} | null;

@Injectable()
export class MlConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async getConfig(facilityId: string): Promise<MlConfigResponseDto> {
    return this.prisma.withFacilityContext(
      facilityId,
      async (tx: Prisma.TransactionClient) => {
        const [cameras, config] = await Promise.all([
          tx.camera.findMany({
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              spaceId: true,
              label: true,
              rtspUrl: true,
              online: true,
              createdAt: true,
              space: {
                select: {
                  name: true,
                  floor: { select: { name: true } },
                },
              },
            },
          }),
          tx.mlFacilityConfig.findUnique({ where: { facilityId } }),
        ]);

        return {
          configVersion: config?.configVersion ?? 0,
          nightWindow: config
            ? { start: config.nightStart, end: config.nightEnd, tz: config.tz }
            : DEFAULT_NIGHT_WINDOW,
          cameras: cameras.map((camera) => {
            const space = camera.space as CameraLocation;
            return {
              id: camera.id,
              spaceId: camera.spaceId,
              label: camera.label,
              rtspUrl: camera.rtspUrl ?? null,
              online: camera.online,
              spaceName: space?.name ?? null,
              floorName: space?.floor?.name ?? null,
              createdAt: camera.createdAt.toISOString(),
            };
          }),
        };
      },
    );
  }

  async updateNightWindow(
    facilityId: string,
    dto: UpdateNightWindowRequestDto,
  ): Promise<MlConfigResponseDto> {
    if (!HH_MM.test(dto.start) || !HH_MM.test(dto.end)) {
      throw new BadRequestException('night window times must be HH:MM');
    }
    if (!dto.tz.trim()) {
      throw new BadRequestException('tz is required');
    }

    await this.prisma.withFacilityContext(
      facilityId,
      async (tx: Prisma.TransactionClient) => {
        await tx.mlFacilityConfig.upsert({
          where: { facilityId },
          create: {
            facilityId,
            configVersion: 1,
            nightStart: dto.start,
            nightEnd: dto.end,
            tz: dto.tz,
          },
          update: {
            nightStart: dto.start,
            nightEnd: dto.end,
            tz: dto.tz,
            configVersion: { increment: 1 },
          },
        });
      },
    );

    return this.getConfig(facilityId);
  }
}
