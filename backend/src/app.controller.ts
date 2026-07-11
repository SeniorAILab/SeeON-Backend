import {
  Controller,
  Get,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
  Version,
} from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Version(VERSION_NEUTRAL)
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Version(VERSION_NEUTRAL)
  @Get('health')
  async getHealth() {
    const health = await this.appService.getHealth();
    if (health.status !== 'ok') {
      throw new ServiceUnavailableException(health);
    }
    return health;
  }
}
