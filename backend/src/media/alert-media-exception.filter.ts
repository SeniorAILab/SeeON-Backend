import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

const CACHE_CONTROL = 'private, no-store, no-transform';
const FORBIDDEN_DENIAL_HEADERS = [
  'accept-ranges',
  'content-disposition',
  'content-range',
  'etag',
] as const;

@Catch()
export class AlertMediaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AlertMediaExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const isHttpException = exception instanceof HttpException;
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse = isHttpException
      ? exception.getResponse()
      : { statusCode: status, message: 'Internal server error' };
    const body =
      isHttpException && typeof exceptionResponse === 'string'
        ? { statusCode: status, message: exceptionResponse }
        : exceptionResponse;
    if (!isHttpException) {
      this.logger.error({ event: 'alert_media.unhandled' });
    }
    const payload = Buffer.from(JSON.stringify(body));

    response.status(status);
    response.setHeader('cache-control', CACHE_CONTROL);
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('content-length', String(payload.length));
    for (const header of FORBIDDEN_DENIAL_HEADERS) {
      response.removeHeader(header);
    }
    response.end(payload);
  }
}
