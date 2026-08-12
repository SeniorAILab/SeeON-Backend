import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { parseFrontendOrigins } from '../config/frontend-origins.js';
import { SKIP_CSRF_METADATA_KEY } from './skip-csrf.decorator.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class CsrfOriginGuard implements CanActivate {
  private readonly enabled: boolean;
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService,
  ) {
    this.enabled = config.get<string>('NODE_ENV') === 'production';
    const frontendOrigins = config.get<string>('FRONT_ORIGINS');
    const frontendOrigin = config.get<string>('FRONT_ORIGIN');
    this.allowedOrigins = new Set(
      parseFrontendOrigins({
        NODE_ENV: config.get<string>('NODE_ENV'),
        ...(frontendOrigins === undefined
          ? frontendOrigin === undefined
            ? {}
            : { FRONT_ORIGIN: frontendOrigin }
          : { FRONT_ORIGINS: frontendOrigins }),
      }),
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!this.enabled || !UNSAFE_METHODS.has(request.method.toUpperCase())) {
      return true;
    }
    if (
      this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_METADATA_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    ) {
      return true;
    }

    const originHeader = request.headers.origin;
    if (originHeader !== undefined) {
      if (
        typeof originHeader === 'string' &&
        exactOrigin(originHeader) === originHeader &&
        this.allowedOrigins.has(originHeader)
      ) {
        return true;
      }
      throw rejected();
    }

    const referer = request.headers.referer;
    if (typeof referer === 'string') {
      const refererOrigin = exactRefererOrigin(referer);
      if (refererOrigin !== null && this.allowedOrigins.has(refererOrigin)) {
        return true;
      }
    }
    throw rejected();
  }
}

function exactOrigin(value: string): string | null {
  if (value.trim() !== value || value.includes(',')) return null;
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      (url.protocol !== 'http:' && url.protocol !== 'https:')
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function exactRefererOrigin(value: string): string | null {
  if (value.trim() !== value || value.includes(',')) return null;
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'http:' && url.protocol !== 'https:')
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function rejected(): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    code: 'CSRF_ORIGIN_REJECTED',
    message: 'Request origin rejected',
  });
}
