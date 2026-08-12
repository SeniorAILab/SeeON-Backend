import type { INestApplication } from '@nestjs/common';
import type { Application } from 'express';

export const TRUSTED_INGRESS_PROXY_CIDR = '172.30.0.0/24';

export function configureTrustedIngressProxy(
  app: INestApplication,
  trustedProxy: string = TRUSTED_INGRESS_PROXY_CIDR,
): void {
  const instance: unknown = app.getHttpAdapter().getInstance();
  const expressApp = instance as Application;
  expressApp.set('trust proxy', trustedProxy);
}
