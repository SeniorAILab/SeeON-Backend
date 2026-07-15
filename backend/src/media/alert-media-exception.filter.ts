import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Response } from 'express';

const CACHE_CONTROL = 'private, no-store, no-transform';
const FORBIDDEN_DENIAL_HEADERS = [
  'accept-ranges',
  'content-disposition',
  'content-range',
  'etag',
] as const;

@Catch(HttpException)
export class AlertMediaExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();
    const body =
      typeof exceptionResponse === 'string'
        ? { statusCode: status, message: exceptionResponse }
        : exceptionResponse;
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
