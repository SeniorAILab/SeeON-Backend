import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

const DEPLOY_SHA_PATTERN = /^[a-f0-9]{40}$/;

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  getHello(): string {
    return 'Hello World!';
  }

  async getHealth() {
    const sha = process.env.DEPLOY_SHA;
    const validSha = sha !== undefined && DEPLOY_SHA_PATTERN.test(sha);
    let database = 'ok';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'unhealthy';
    }

    return {
      status: database === 'ok' && validSha ? 'ok' : 'unhealthy',
      sha: validSha ? sha : 'unknown',
      database,
    };
  }
}
