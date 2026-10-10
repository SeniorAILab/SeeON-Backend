import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ESLint } from 'eslint';
import { format } from 'prettier';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import mainConfig from '../eslint.config.mjs';
import dtoConfig from '../eslint.dto.config.mjs';

const backend = path.resolve(import.meta.dirname, '..');
let root;
const sources = new Map();
function startupFixture(
  imports = '',
  body = '',
  failure = 'console.error(error); process.exit(1);',
) {
  return `import { NestFactory as Factory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
${imports}
async function launch(): Promise<void> {
const app = await Factory.create(AppModule);
const alias = app;
alias.setGlobalPrefix('api');
${body}
await alias.listen(8080);
}
launch().catch((error: unknown) => { void error; ${failure} });`;
}
test('Nest constructs a plain class provider without inferred constructor metadata', async () => {
  let constructions = 0;
  class PlainDefaultAdapter {
    constructor(executable = 'ffprobe', optional) {
      constructions += 1;
      this.executable = executable;
      this.optional = optional;
    }
  }
  assert.equal(
    Reflect.getMetadata('design:paramtypes', PlainDefaultAdapter),
    undefined,
  );
  const module = await Test.createTestingModule({
    providers: [PlainDefaultAdapter],
  }).compile();
  try {
    const instance = module.get(PlainDefaultAdapter);
    assert.equal(constructions, 1);
    assert.equal(instance.executable, 'ffprobe');
    assert.equal(instance.optional, undefined);
    assert.equal(module.get(PlainDefaultAdapter), instance);
  } finally {
    await module.close();
  }
});
function contextSource({
  imports = "import { AsyncLocalStorage } from 'node:async_hooks';",
  storage = 'const storage = new AsyncLocalStorage<{ id: string }>();',
  members,
  exported = 'export { Context };',
  extra = '',
} = {}) {
  return `${imports}
${storage}
const Context = ({
${
  members ??
  `run<T>(id: string, fn: () => T): T { return storage.run({ id }, fn); },
get(): string | undefined { return storage.getStore()?.id; }`
}
} as const);
${exported}
${extra}`;
}
function scopeSource({
  role = 'Interceptor',
  fakeContract = false,
  forged = false,
  forwarding = 'fn',
  extra = '',
} = {}) {
  const decorator = role === 'Controller' ? 'Controller' : 'Injectable';
  const transaction =
    role === 'Controller' ? 'unknown' : 'Prisma.TransactionClient';
  return `import { ${decorator}, type ExecutionContext, type CallHandler${fakeContract ? '' : ', type NestInterceptor'} } from '@nestjs/common';
import type { Observable } from 'rxjs';
${role === 'Controller' ? '' : "import type { Prisma } from '@prisma/client';"}
import { PrismaService } from '../../prisma/prisma.service.js';
type Runner = <T>(fn: (tx: ${transaction}) => Promise<T>) => Promise<T>;
${fakeContract ? 'interface NestInterceptor { intercept(context: ExecutionContext, next: CallHandler): Observable<unknown>; }' : ''}
@${decorator}() export class Scope${role} implements NestInterceptor {
${forged ? 'private readonly prisma = null as unknown as PrismaService;' : 'constructor(private readonly prisma: PrismaService) {}'}
intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
const request = context.switchToHttp().getRequest<{ facilityId: string; withFacilityContext?: Runner }>();
const facilityId = request.facilityId;
request.withFacilityContext = <T>(fn: (tx: ${transaction}) => Promise<T>) => this.prisma.withFacilityContext<T>(facilityId, ${forwarding});
${extra}
return next.handle();
}
}`;
}
const fixtures = {
  'src/context/services/context.service.ts': contextSource(),
  'src/common/services/tenant-context.service.ts': `import { AsyncLocalStorage } from 'node:async_hooks';
const storage = new AsyncLocalStorage<{ facilityId: string }>();
export const TenantContext = {
getBoundFacilityId(): string | undefined { return storage.getStore()?.facilityId; },
runBound<T>(facilityId: string, fn: () => T): T { return storage.run({ facilityId }, fn); }
} as const;`,
  'src/context/helpers/misplaced.helper.ts': contextSource(),
  'src/context/adapters/context.adapter.ts': contextSource(),
  'src/context/services/bad-consumer.service.ts': `import { Context } from '../adapters/context.adapter.js';
export function expose() { return Context; }`,
  'src/context/services/consumer.service.ts': `import { Context } from './context.service.js';
export function read(): string | undefined { return Context.get(); }`,
  'src/context/services/forged.service.ts': contextSource({
    imports: "import type { AsyncLocalStorage } from 'node:async_hooks';",
    storage:
      'declare const Constructor: typeof AsyncLocalStorage; const storage = new Constructor<{ id: string }>();',
  }),
  'src/context/services/typed.service.ts': contextSource({
    imports: "import type { AsyncLocalStorage } from 'node:async_hooks';",
    storage: 'declare const storage: AsyncLocalStorage<{ id: string }>;',
  }),
  'src/context/services/unexported.service.ts': contextSource({
    exported: 'void Context;',
  }),
  'src/context/services/spread.service.ts': contextSource({
    members: `...{ run<T>(id: string, fn: () => T): T { return storage.run({ id }, fn); } }`,
  }),
  'src/context/services/computed.service.ts': contextSource({
    members: `['run']<T>(id: string, fn: () => T): T { return storage.run({ id }, fn); }`,
  }),
  'src/context/services/accessor.service.ts': contextSource({
    members: `get value(): string | undefined { return storage.getStore()?.id; }`,
  }),
  'src/context/services/data.service.ts': `import { AsyncLocalStorage } from 'node:async_hooks';
export const Data = { value: 1 } as const;
export const storage = new AsyncLocalStorage<string>();`,
  'src/context/services/opaque.service.ts': `import { AsyncLocalStorage } from 'node:async_hooks';
declare const opaque: { get(): string };
export const Context = opaque;
export const storage = new AsyncLocalStorage<string>();`,
  'src/context/services/fs.service.ts': contextSource({
    extra: `import { existsSync } from 'node:fs'; existsSync('not-executed');`,
  }),
  'src/context/services/network.service.ts': contextSource({
    extra: `import { request } from 'node:https'; request('https://not-executed.invalid');`,
  }),
  'src/context/services/disable.service.ts': contextSource({
    extra: 'storage.disable();',
  }),
  'src/scope/interceptors/scope.interceptor.ts': scopeSource(),
  'src/scope/interceptors/fake.interceptor.ts': scopeSource({
    fakeContract: true,
  }),
  'src/scope/interceptors/forged.interceptor.ts': scopeSource({ forged: true }),
  'src/scope/interceptors/wrapped.interceptor.ts': scopeSource({
    forwarding: '(tx) => fn(tx)',
  }),
  'src/scope/guards/scope.guard.ts': scopeSource({ role: 'Guard' }),
  'src/scope/controllers/scope.controller.ts': scopeSource({
    role: 'Controller',
  }),
  'src/scope/interceptors/query.interceptor.ts': scopeSource({
    extra: 'void this.prisma.db.facility.findMany();',
  }),
  'src/scope/interceptors/connect.interceptor.ts': scopeSource({
    extra: 'void this.prisma.$connect();',
  }),
  'src/scope/interceptors/raw.interceptor.ts': scopeSource({
    extra: 'void this.prisma.db.$executeRaw`SELECT 1`;',
  }),
  'src/scope/interceptors/fs.interceptor.ts':
    scopeSource({ extra: "existsSync('not-executed');" }) +
    "\nimport { existsSync } from 'node:fs';",
  'src/scope/interceptors/network.interceptor.ts':
    scopeSource({ extra: "httpsRequest('https://not-executed.invalid');" }) +
    "\nimport { request as httpsRequest } from 'node:https';",
  'src/metadata/decorators/skip.decorator.ts': `import { SetMetadata as mark } from '@nestjs/common';
export const KEY = 'fixture:skip';
const Skip = (): MethodDecorator & ClassDecorator => mark(KEY, true);
export { Skip as SkipCsrf };`,
  'src/metadata/decorators/namespace.decorator.ts': `import * as nest from '@nestjs/common';
export const Mark = (): MethodDecorator & ClassDecorator => nest.SetMetadata('fixture', true);`,
  'src/metadata/helpers/misplaced.helper.ts': `import { SetMetadata } from '@nestjs/common';
export const Mark = (): MethodDecorator & ClassDecorator => SetMetadata('fixture', true);`,
  'src/metadata/decorators/forged.decorator.ts': `import type { SetMetadata } from '@nestjs/common';
declare const mark: typeof SetMetadata;
export const Mark = (): MethodDecorator & ClassDecorator => mark('fixture', true);`,
  'src/metadata/decorators/namespace-forged.decorator.ts': `import type * as nest from '@nestjs/common';
declare const fake: typeof nest;
export const Mark = (): MethodDecorator & ClassDecorator => fake.SetMetadata('fixture', true);`,
  'src/metadata/decorators/erased.decorator.ts': `import type { SetMetadata } from '@nestjs/common';
export const Mark = (): MethodDecorator & ClassDecorator => SetMetadata('fixture', true);`,
  'src/metadata/decorators/local.decorator.ts': `declare function SetMetadata(key: string, value: boolean): MethodDecorator & ClassDecorator;
export const Mark = (): MethodDecorator & ClassDecorator => SetMetadata('fixture', true);`,
  'src/metadata/decorators/fs.decorator.ts': `import { SetMetadata } from '@nestjs/common';
import { readFileSync } from 'node:fs';
export const Mark = (): MethodDecorator & ClassDecorator => SetMetadata('fixture', readFileSync('not-executed'));`,
  'src/metadata/decorators/network.decorator.ts': `import { SetMetadata } from '@nestjs/common';
import { request } from 'node:https';
export const Mark = (): MethodDecorator & ClassDecorator => SetMetadata('fixture', request('https://not-executed.invalid'));`,
  'src/metadata/decorators/db.decorator.ts': `import { SetMetadata } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
const client = new PrismaClient();
export const Mark = (): MethodDecorator & ClassDecorator => SetMetadata('fixture', client.facility.findMany());`,
  'src/metadata/controllers/authentic.controller.ts': `import { Controller } from '@nestjs/common';
import { SkipCsrf } from '../decorators/skip.decorator.js';
@Controller('authentic') @SkipCsrf() export class AuthenticController {}`,
  'src/metadata/controllers/fixture.controller.ts': `import { Controller, SetMetadata } from '@nestjs/common';
import { readFileSync } from 'node:fs';
@Controller('fixture') @SetMetadata('fixture', readFileSync('not-executed')) export class FixtureController {}`,
  'src/metadata/guards/fixture.guard.ts': `import { Injectable, SetMetadata } from '@nestjs/common';
import { request } from 'node:https';
@Injectable() @SetMetadata('fixture', request('https://not-executed.invalid')) export class FixtureGuard {}`,
  'src/pathproof/config/storage.config.ts': `import * as path from 'path';
export function root(): string { return process.env.STORAGE_ROOT ?? path.join(process.cwd(), 'storage'); }`,
  'src/pathproof/helpers/paths.helper.ts': `import { join as combine, dirname as parent, resolve as absolute, posix as unix } from 'node:path';
import * as path from 'node:path';
import * as windows from 'node:path/win32';
import defaultPath from 'node:path/posix';
import { cwd as current } from 'node:process';
export function paths(): string[] {
return [combine(current(), 'x'), parent('/x/y'), absolute('x'), unix.join('/x', 'y'), path.posix.dirname('/x/y'), path.win32.resolve('C:/x'), windows.join('C:/x', 'y'), defaultPath.dirname('/x/y')];
}`,
  'src/pathproof/config/cwd.config.ts': `import host from 'node:process';
export function directory(): string { return host.cwd(); }`,
  'src/pathproof/helpers/lookalike.helper.ts': `declare const lookalike: { join(...parts: string[]): string };
export function root(): string { return lookalike.join('x'); }`,
  'src/pathproof/helpers/opaque.helper.ts': `declare function dirname(value: string): string;
export function root(): string { return dirname('x'); }`,
  'src/pathproof/helpers/typed-path.helper.ts': `import type * as path from 'node:path';
declare const forged: typeof path;
export function root(): string { return forged.join('x'); }`,
  'src/pathproof/helpers/typed-platform.helper.ts': `import type * as path from 'node:path';
declare const forged: path.PlatformPath;
export function root(): string { return forged.posix.resolve('x'); }`,
  'src/pathproof/helpers/typed-process.helper.ts': `declare const forged: NodeJS.Process;
export function root(): string { return forged.cwd(); }`,
  'src/pathproof/helpers/shadow.helper.ts': `declare const process: NodeJS.Process;
export function root(): string { return process.cwd(); }`,
  'src/pathproof/helpers/alias.helper.ts': `import * as path from 'node:path';
const local = path;
export function root(): string { return local.join('x'); }`,
  'src/pathproof/config/chdir.config.ts': `export function mutate(): void { process.chdir('/not-executed'); }`,
  'src/pathproof/config/exit.config.ts': `export function terminate(): never { return process.exit(1); }`,
  'src/pathproof/config/kill.config.ts': `export function signal(): boolean { return process.kill(123456); }`,
  'src/pathproof/helpers/unsupported.helper.ts': `import * as path from 'node:path';
export function name(): string { return path.basename('/x/y'); }`,
  'src/pathproof/config/exists.config.ts': `import { existsSync } from 'node:fs';
export function probe(): boolean { return existsSync('not-executed'); }`,
  'src/pathproof/config/write.config.ts': `import { writeFileSync } from 'node:fs';
export function mutate(): void { writeFileSync('not-executed', 'data'); }`,
  'src/pathproof/config/escape.config.ts': `import { join } from 'node:path';
import { readFileSync } from 'node:fs';
export function root(): string { return join(readFileSync('not-executed', 'utf8'), 'x'); }`,
  'src/pathproof/config/network.config.ts': `import { request } from 'node:https';
export function send(): void { request('https://not-executed.invalid'); }`,
  'src/manual/ports/runtime.port.ts': `export interface Runtime { now(): Date; }`,
  'src/manual/repositories/audit.repository.ts': `import { Injectable } from '@nestjs/common';
@Injectable() export class AuditRepository { save(id: string, now: Date): string { return id + now.toISOString(); } }`,
  'src/manual/services/session.service.ts': `import type { AuditRepository } from '../repositories/audit.repository.js';
import type { Runtime } from '../ports/runtime.port.js';
import { ChainedService } from './chained.service.js';
export class SessionService {
constructor(private readonly id: string, private readonly repository: AuditRepository, private readonly runtime: Runtime) {}
finish(): string { return this.repository.save(this.id, this.runtime.now()); }
chain(): ChainedService { return new ChainedService(this.id); }
}`,
  'src/manual/services/chained.service.ts': `export class ChainedService { constructor(readonly id: string) {} }`,
  'src/manual/services/producer.service.ts': `import { Injectable } from '@nestjs/common';
import { AuditRepository } from '../repositories/audit.repository.js';
import type { Runtime } from '../ports/runtime.port.js';
import { SessionService as Session } from './session.service.js';
@Injectable() export class ProducerService {
constructor(private readonly repository: AuditRepository) {}
async begin(id: string, runtime: Runtime): Promise<Session> {
await Promise.resolve();
return new Session(id, this.repository, runtime);
}
}`,
  'src/manual/services/unowned.service.ts': `export class UnownedService { constructor(readonly id: string) {} }`,
  'src/manual/helpers/unowned.helper.ts': `import { UnownedService } from '../services/unowned.service.js';
export function make(id: string): UnownedService { return new UnownedService(id); }`,
  'src/manual/services/fake-target.service.ts': `export class FakeTargetService { constructor(readonly id: string) {} }`,
  'src/manual/services/fake-producer.service.ts': `import { FakeTargetService } from './fake-target.service.js';
function Injectable(): ClassDecorator { return () => undefined; }
@Injectable() export class FakeProducerService { make(): FakeTargetService { return new FakeTargetService('id'); } }`,
  'src/manual/services/erased.service.ts': `export class ErasedService { constructor(readonly id: string) {} }`,
  'src/manual/services/wrapped.service.ts': `export class WrappedService { constructor(readonly id: string) {} }`,
  'src/manual/services/different.service.ts': `export class DifferentService { constructor(readonly id: string) {} }`,
  'src/manual/services/domain.service.ts': `export class DomainService { constructor(readonly id: string) {} }`,
  'src/manual/services/path-only.service.ts': `export class PathOnlyService { constructor(readonly id: string) {} }`,
  'src/manual/services/name.service.ts': `export class Worker { constructor(readonly id: string) {} }`,
  'src/manual/services/automatic.service.ts': `import { Injectable } from '@nestjs/common';
@Injectable() export class AutomaticService { constructor(readonly id: string) {} }`,
  'src/manual/services/registered.service.ts': `export class RegisteredService { constructor(readonly id: string) {} }`,
  'src/manual/manual.module.ts': `import { Module } from '@nestjs/common';
import { RegisteredService } from './services/registered.service.js';
@Module({ providers: [RegisteredService] }) export class ManualModule {}`,
  'src/manual/services/negative-producer.service.ts': `import { Injectable } from '@nestjs/common';
import type { ErasedService as Erased } from './erased.service.js';
import { WrappedService } from './wrapped.service.js';
import { DifferentService } from './different.service.js';
import { AutomaticService } from './automatic.service.js';
import { RegisteredService } from './registered.service.js';
import { Worker } from './name.service.js';
interface Other { readonly id: string; }
function wrap(value: WrappedService): WrappedService { return value; }
@Injectable() export class NegativeProducerService {
erased(): Erased { return new Erased('id'); }
wrapped(): WrappedService { return wrap(new WrappedService('id')); }
different(): Other { return new DifferentService('id'); }
automatic(): AutomaticService { return new AutomaticService('id'); }
registered(): RegisteredService { return new RegisteredService('id'); }
wrongName(): Worker { return new Worker('id'); }
}`,
  'src/foreign/services/foreign.service.ts': `import { Injectable } from '@nestjs/common';
import { DomainService } from '../../manual/services/domain.service.js';
@Injectable() export class ForeignService { make(): DomainService { return new DomainService('id'); } }`,
  'src/clock/ports/named.port.ts': `abstract class ClockPort { abstract nowMs(): number; }
export { ClockPort as Token };`,
  'src/clock/named-barrel.ts': `export { Token as AliasedToken } from './ports/named.port.js';`,
  'src/clock/named.module.ts': `import { Module } from '@nestjs/common';
import { AliasedToken } from './named-barrel.js';
import { SystemClock } from './adapters/system-clock.adapter.js';
@Module({ providers: [{ provide: AliasedToken, useClass: SystemClock }] }) export class NamedModule {}`,
  'src/clock/ports/unregistered-named.port.ts': `abstract class UnregisteredClock { abstract nowMs(): number; }
export { UnregisteredClock as Token };`,
  'src/clock/erased-barrel.ts': `export type { Token } from './ports/named.port.js';`,
  'src/clock/erased-barrel.module.ts': `import { Module } from '@nestjs/common';
import { Token } from './erased-barrel.js';
import { SystemClock } from './adapters/system-clock.adapter.js';
@Module({ providers: [{ provide: Token, useClass: SystemClock }] }) export class ErasedBarrelModule {}`,
  'src/headers/controllers/end.controller.ts': `import { Controller } from '@nestjs/common';
import type { ClientRequest } from 'node:http';
@Controller('end') export class EndController { send(request: ClientRequest): void { request.end(); } }`,
  'src/headers/controllers/mixed-write.controller.ts': `import { Controller } from '@nestjs/common';
import type { Response } from 'express';
import type { ClientRequest } from 'node:http';
@Controller('mixed-write') export class MixedWriteController { send(response: Response | ClientRequest): void { response.write('body'); } }`,
  'src/headers/controllers/generic.controller.ts': `import { Controller } from '@nestjs/common';
import type { Response } from 'express';
@Controller('generic') export class GenericController { send<T>(response: Response & T): void { response.setHeader('x-test', 'value'); } }`,
  'src/headers/controllers/streams.controller.ts': `import { Controller, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Writable } from 'node:stream';
@Controller('streams') export class StreamsController {
inbound(@Res() response: Response): void { response.write('body'); response.end(); }
memory(stream: Writable): void { stream.write('body'); stream.end(); }
}`,
  'src/headers/controllers/generic-write.controller.ts': `import { Controller } from '@nestjs/common';
import type { ClientRequest } from 'node:http';
@Controller('generic-write') export class GenericWriteController { send<T>(request: ClientRequest & T): void { request.write('body'); } }`,
  'src/headers/controllers/generic-end.controller.ts': `import { Controller } from '@nestjs/common';
import type { ClientRequest } from 'node:http';
@Controller('generic-end') export class GenericEndController { send<T>(request: ClientRequest & T): void { request.end(); } }`,
  'src/headers/controllers/inherited-write.controller.ts': `import { Controller } from '@nestjs/common';
import type { ClientRequest } from 'node:http';
interface Outbound extends ClientRequest { readonly marker: string; }
@Controller('inherited-write') export class InheritedWriteController { send(request: Outbound): void { request.write('body'); } }`,
  'src/headers/controllers/generic-stream.controller.ts': `import { Controller } from '@nestjs/common';
import type { Writable } from 'node:stream';
@Controller('generic-stream') export class GenericStreamController { memory<T>(stream: Writable & T): void { stream.write('body'); stream.end(); } }`,
  'src/headers/controllers/constrained-write.controller.ts': `import { Controller } from '@nestjs/common';
import type { ClientRequest } from 'node:http';
@Controller('constrained-write') export class ConstrainedWriteController { send<T extends ClientRequest>(request: T): void { request.write('body'); } }`,
  'src/headers/controllers/constrained-end.controller.ts': `import { Controller } from '@nestjs/common';
import type { ClientRequest } from 'node:http';
@Controller('constrained-end') export class ConstrainedEndController { send<T extends ClientRequest>(request: T): void { request.end(); } }`,
  'src/headers/controllers/constrained-stream.controller.ts': `import { Controller } from '@nestjs/common';
import type { Writable } from 'node:stream';
@Controller('constrained-stream') export class ConstrainedStreamController { memory<T extends Writable>(stream: T): void { stream.write('body'); stream.end(); } }`,
  'src/aux/guards/cookie.guard.ts': `import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';
@Injectable() export class CookieGuard implements CanActivate {
canActivate(context: ExecutionContext): boolean {
const response = context.switchToHttp().getResponse<Response>();
response.cookie('app_media_facility', 'facility');
return true;
}
}`,
  'src/aux/filters/response.filter.ts': `import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
@Catch() export class ResponseFilter implements ExceptionFilter {
catch(exception: unknown, host: ArgumentsHost): void {
void exception;
const response = host.switchToHttp().getResponse<Response>();
response.status(403);
response.setHeader('cache-control', 'no-store');
response.removeHeader('content-length');
}
}`,
  'src/aux/aux.module.ts': `import { Module } from '@nestjs/common';
import { ResponseFilter } from './filters/response.filter.js';
@Module({ providers: [ResponseFilter] }) export class AuxModule {}`,
  'src/aux/guards/client.guard.ts': `import { Injectable } from '@nestjs/common';
import type { ClientRequest } from 'node:http';
@Injectable() export class ClientGuard { run(request: ClientRequest): void { request.removeHeader('x-test'); } }`,
  'src/aux/filters/client.filter.ts': `import { Injectable, Catch } from '@nestjs/common';
import type { ClientRequest } from 'node:http';
@Injectable() @Catch() export class ClientFilter { run(request: ClientRequest): void { request.removeHeader('x-test'); } }`,
  'src/aux/guards/network.guard.ts': `import { Injectable } from '@nestjs/common';
import { request } from 'node:https';
@Injectable() export class NetworkGuard { run(): void { request('https://not-executed.invalid'); } }`,
  'src/aux/filters/network.filter.ts': `import { Injectable, Catch } from '@nestjs/common';
import { request } from 'node:https';
@Injectable() @Catch() export class NetworkFilter { run(): void { request('https://not-executed.invalid'); } }`,
  'src/aux/guards/disk.guard.ts': `import { Injectable } from '@nestjs/common';
import { unlinkSync } from 'node:fs';
@Injectable() export class DiskGuard { run(): void { unlinkSync('not-executed'); } }`,
  'src/aux/filters/disk.filter.ts': `import { Injectable, Catch } from '@nestjs/common';
import { unlinkSync } from 'node:fs';
@Injectable() @Catch() export class DiskFilter { run(): void { unlinkSync('not-executed'); } }`,
  'src/aux/guards/query.guard.ts': `import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
@Injectable() export class QueryGuard { async run(db: PrismaClient): Promise<void> { await db.user.findMany(); } }`,
  'src/aux/filters/query.filter.ts': `import { Injectable, Catch } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
@Injectable() @Catch() export class QueryFilter { async run(db: PrismaClient): Promise<void> { await db.user.findMany(); } }`,
  'src/aux/guards/functional-query.guard.ts': `import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { readRows } from '../../pure/repositories/functional.repository.js';
@Injectable() export class FunctionalQueryGuard { async run(db: PrismaClient): Promise<void> { await readRows(db); } }`,
  'src/aux/filters/functional-query.filter.ts': `import { Injectable, Catch } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { readRows } from '../../pure/repositories/functional.repository.js';
@Injectable() @Catch() export class FunctionalQueryFilter { async run(db: PrismaClient): Promise<void> { await readRows(db); } }`,
  'src/aux/guards/overload-query.guard.ts': `import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { readPage } from '../../pure/repositories/signature.repository.js';
@Injectable() export class OverloadQueryGuard { async run(db: PrismaClient): Promise<void> { await readPage(db, 1); } }`,
  'src/aux/filters/annotated-query.filter.ts': `import { Injectable, Catch } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { listRows } from '../../pure/repositories/signature.repository.js';
@Injectable() @Catch() export class AnnotatedQueryFilter { async run(db: PrismaClient): Promise<void> { await listRows(db); } }`,
  'src/aux/helpers/misplaced.helper.ts': `import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
@Injectable() export class MisplacedGuard { run(response: Response): void { response.cookie('key', 'value'); } }`,
  'src/aux/helpers/header.helper.ts': `import type { Response } from 'express';
export function remove(response: Response): void { response.removeHeader('x-test'); }`,
  'src/headers/controllers/inbound.controller.ts': `import { Controller, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ServerResponse } from 'node:http';
type Inbound = Response;
interface Augmented extends ServerResponse { readonly marker: string; }
@Controller('headers') export class InboundController {
express(@Res() response: Inbound): void { const alias = response; alias.setHeader('x-test', 'value'); this.headers(alias); }
native(@Res() response: ServerResponse): void { response.setHeader('x-test', 'value'); }
inherited(response: Augmented): void { response.setHeader('x-test', 'value'); }
either(response: Response | ServerResponse): void { response.setHeader('x-test', 'value'); }
private headers(response: Response): void { response.setHeader('cache-control', 'no-store'); }
}`,
  'src/headers/controllers/client.controller.ts': `import { Controller } from '@nestjs/common';
import type { ClientRequest } from 'node:http';
@Controller('client') export class ClientController { send(request: ClientRequest): void { request.setHeader('x-test', 'value'); } }`,
  'src/headers/controllers/lookalike.controller.ts': `import { Controller } from '@nestjs/common';
import type { ClientRequest } from 'node:http';
interface Response extends ClientRequest { readonly marker: string; }
@Controller('fake') export class LookalikeController { send(response: Response): void { response.setHeader('x-test', 'value'); } }`,
  'src/headers/controllers/mixed.controller.ts': `import { Controller } from '@nestjs/common';
import type { Response } from 'express';
import type { ClientRequest } from 'node:http';
@Controller('mixed') export class MixedController { send(response: Response | ClientRequest): void { response.setHeader('x-test', 'value'); } }`,
  'src/headers/helpers/headers.helper.ts': `import type { Response } from 'express';
export function headers(response: Response): void { response.setHeader('x-test', 'value'); }`,
  'src/headers/controllers/write.controller.ts': `import { Controller } from '@nestjs/common';
import type { ClientRequest } from 'node:http';
@Controller('write') export class WriteController { send(request: ClientRequest): void { request.write('body'); } }`,
  'src/clock/ports/clock.port.ts': `export abstract class Clock { abstract nowMs(): number; }`,
  'src/clock/ports/unused.port.ts': `export abstract class UnusedClock { abstract nowMs(): number; }`,
  'src/clock/ports/fake.port.ts': `export abstract class FakeClock { abstract nowMs(): number; }`,
  'src/clock/ports/concrete.port.ts': `export class ConcreteClock { nowMs(): number { return 0; } }`,
  'src/clock/ports/stateful.port.ts': `import { readFileSync } from 'node:fs';
export abstract class StatefulClock { static value = readFileSync('not-executed'); abstract nowMs(): number; }`,
  'src/clock/ports/forged.port.ts': `export abstract class ForgedClock { abstract nowMs(): string; }`,
  'src/clock/misplaced.ts': `export abstract class MisplacedClock { abstract nowMs(): number; }`,
  'src/clock/adapters/system-clock.adapter.ts': `import { Injectable } from '@nestjs/common';
import { Clock } from '../ports/clock.port.js';
@Injectable() export class SystemClock extends Clock { nowMs(): number { return Date.now(); } }`,
  'src/clock/clock.module.ts': `import { Module as NestModule } from '@nestjs/common';
import { Clock as AliasedClock } from './ports/clock.port.js';
import { ConcreteClock } from './ports/concrete.port.js';
import { StatefulClock } from './ports/stateful.port.js';
import { MisplacedClock } from './misplaced.js';
import { SystemClock } from './adapters/system-clock.adapter.js';
@NestModule({ providers: [
{ provide: AliasedClock, useClass: SystemClock },
{ provide: ConcreteClock, useClass: SystemClock },
{ provide: StatefulClock, useClass: SystemClock },
{ provide: MisplacedClock, useClass: SystemClock }
] }) export class ClockModule {}`,
  'src/clock/fake.module.ts': `import { FakeClock } from './ports/fake.port.js';
import { SystemClock } from './adapters/system-clock.adapter.js';
function Module(_metadata: unknown): ClassDecorator { return () => undefined; }
@Module({ providers: [{ provide: FakeClock, useClass: SystemClock }] }) export class FakeModule {}`,
  'src/clock/forged.module.ts': `import { Module } from '@nestjs/common';
import { ForgedClock } from './ports/forged.port.js';
import { SystemClock } from './adapters/system-clock.adapter.js';
@Module({ providers: [{ provide: ForgedClock, useClass: SystemClock }] }) export class ForgedModule {}`,
  'src/clock/erased.module.ts': `import { Module } from '@nestjs/common';
import type { FakeClock } from './ports/fake.port.js';
import { SystemClock } from './adapters/system-clock.adapter.js';
@Module({ providers: [{ provide: FakeClock, useClass: SystemClock }] }) export class ErasedModule {}`,
  'src/clock/async.module.ts': `import { Module } from '@nestjs/common';
import { Clock } from './ports/clock.port.js';
import { SystemClock } from './adapters/system-clock.adapter.js';
@Module({ providers: [{ provide: Clock, useFactory: async (): Promise<SystemClock> => {
await Promise.resolve();
return new SystemClock();
} }] }) export class AsyncModule {}`,
  'src/clock/wrong-async.module.ts': `import { Module } from '@nestjs/common';
import { ForgedClock } from './ports/forged.port.js';
import { SystemClock } from './adapters/system-clock.adapter.js';
@Module({ providers: [{ provide: ForgedClock, useFactory: async (): Promise<SystemClock> => {
await Promise.resolve();
return new SystemClock();
} }] }) export class WrongAsyncModule {}`,
  'src/clock/namespace.module.ts': `import { Module } from '@nestjs/common';
import * as Tokens from './ports/clock.port.js';
import { SystemClock } from './adapters/system-clock.adapter.js';
@Module({ providers: [{ provide: Tokens.Clock, useClass: SystemClock }] }) export class NamespaceModule {}`,
  'src/clock/erased-namespace.module.ts': `import { Module } from '@nestjs/common';
import type * as Tokens from './ports/fake.port.js';
import { SystemClock } from './adapters/system-clock.adapter.js';
@Module({ providers: [{ provide: Tokens.FakeClock, useClass: SystemClock }] }) export class ErasedNamespaceModule {}`,
  'src/startup/renamed.ts': startupFixture(),
  'src/startup/host-alias.ts': startupFixture(
    '',
    '',
    'const log = console; const host = process; log.error(error); host.exit(1);',
  ),
  'src/startup/write.ts': startupFixture(
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('not-executed', 'data');",
  ),
  'src/startup/catch-write.ts': startupFixture(
    "import { writeFileSync } from 'node:fs';",
    '',
    "console.error(error); writeFileSync('not-executed', 'data'); process.exit(1);",
  ),
  'src/startup/spawn.ts': startupFixture(
    "import { execFile } from 'node:child_process';",
    "execFile('not-executed');",
  ),
  'src/startup/network.ts': startupFixture(
    "import { request } from 'node:https';",
    "request('https://not-executed.invalid');",
  ),
  'src/startup/query.ts': startupFixture(
    "import type { PrismaClient } from '@prisma/client';\ndeclare const db: PrismaClient;",
    'await db.user.findMany();',
  ),
  'src/startup/typed-console.ts': startupFixture(
    'declare const forged: typeof console;',
    '',
    'forged.error(error);',
  ),
  'src/startup/typed-host-object.ts': startupFixture(
    'declare const forged: typeof globalThis;',
    '',
    'forged.console.error(error);',
  ),
  'src/startup/typed-process.ts': startupFixture(
    'declare const forged: typeof process;',
    '',
    'forged.exit(1);',
  ),
  'src/startup/exit-zero.ts': startupFixture('', '', 'process.exit(0);'),
  'src/startup/nested-callback.ts': startupFixture(
    '',
    '',
    'const later = () => console.error(error); later();',
  ),
  'src/startup/pure-lookalike.ts': startupFixture(
    '',
    '',
    'const console = { error: (value: unknown): void => { void value; } }; console.error(error);',
  ),
  'src/startup/shadow.ts': startupFixture(
    'declare const substitute: typeof console;',
    '',
    'const console = substitute; console.error(error);',
  ),
  'src/startup/fake-promise.ts': `export {};
declare const fake: Promise<void>;
fake.catch((error: unknown) => { console.error(error); });`,
  'src/startup/fake-callee.ts': `import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
export async function launch(): Promise<void> {
const app = await NestFactory.create(AppModule);
app.setGlobalPrefix('api');
await app.listen(8080);
}
declare const forged: typeof launch;
forged().catch((error: unknown) => { console.error(error); });`,
  'src/startup/unrelated.ts': `export function report(error: unknown): never { console.error(error); process.exit(1); }`,
  'src/startup/no-listen.ts': `import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
async function launch(): Promise<void> {
const app = await NestFactory.create(AppModule);
app.setGlobalPrefix('api');
}
launch().catch((error: unknown) => { console.error(error); });`,
  'src/plain/adapters/default.adapter.ts': `interface Inspector { inspect(): string; }
export class DefaultInspector implements Inspector {
constructor(private readonly executable = 'ffprobe') {}
inspect(): string { return this.executable; }
}`,
  'src/plain/adapters/optional.adapter.ts': `export class OptionalAdapter {
constructor(readonly label?: string) {}
}`,
  'src/plain/services/required.service.ts': `import { GoodService } from '../../demo/services/good.service.js';
export const dependencyToken = GoodService;
export class RequiredService { constructor(readonly dependency: GoodService) {} }`,
  'src/plain/services/decorated.service.ts': `import { Injectable } from '@nestjs/common';
@Injectable() export class DecoratedService { constructor(readonly executable = 'ffprobe') {} }`,
  'src/plain/services/base.service.ts': `import { Injectable, Inject } from '@nestjs/common';
@Injectable() export class BaseService { constructor(@Inject('TOKEN') readonly token: string) {} }`,
  'src/plain/services/inherited.service.ts': `import { BaseService } from './base.service.js';
export class InheritedService extends BaseService {
constructor(token = 'local') { super(token); }
}`,
  'src/plain/services/static.service.ts': `export class StaticService {
static metadata = 'unknown';
constructor(readonly executable = 'ffprobe') {}
}`,
  'src/plain/services/forged.service.ts': `function Injectable(): ClassDecorator { return () => undefined; }
@Injectable() export class ForgedService { constructor(readonly executable = 'ffprobe') {} }`,
  'src/plain/services/reflected.service.ts': `import 'reflect-metadata';
export class ReflectedService { constructor(readonly executable = 'ffprobe') {} }
Reflect.defineMetadata('design:paramtypes', [String], ReflectedService);`,
  'src/plain/plain.module.ts': `import { Module } from '@nestjs/common';
import { DefaultInspector } from './adapters/default.adapter.js';
import { OptionalAdapter } from './adapters/optional.adapter.js';
import { RequiredService } from './services/required.service.js';
import { DecoratedService } from './services/decorated.service.js';
import { InheritedService } from './services/inherited.service.js';
import { StaticService } from './services/static.service.js';
import { ForgedService } from './services/forged.service.js';
import { ReflectedService } from './services/reflected.service.js';
@Module({ providers: [DefaultInspector, OptionalAdapter, RequiredService, DecoratedService, InheritedService, StaticService, ForgedService, ReflectedService] }) export class PlainModule {}`,
  'src/selected/dto/payload-request.dto.ts': `export class PayloadDto { value?: string; }
export interface ManualDto { id: string; }`,
  'src/selected/pipes/text.pipe.ts': `import { Injectable, type PipeTransform } from '@nestjs/common';
@Injectable() export class TextPipe implements PipeTransform<string, string> {
transform(value: string): string { return value.trim(); }
}`,
  'src/selected/pipes/object.pipe.ts': `import { Injectable, type PipeTransform } from '@nestjs/common';
@Injectable() export class ObjectPipe implements PipeTransform<string, { id: string }> {
transform(value: string): { id: string } { return { id: value }; }
}`,
  'src/selected/pipes/manual.pipe.ts': `import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ManualDto } from '../dto/payload-request.dto.js';
@Injectable() export class ManualPipe implements PipeTransform<string, ManualDto> {
transform(value: string): ManualDto { return { id: value }; }
}`,
  'src/selected/pipes/erased.pipe.ts': `import { Injectable, type PipeTransform } from '@nestjs/common';
@Injectable() export class ErasedPipe implements PipeTransform<unknown, unknown> {
transform(value: unknown): unknown { return value; }
}`,
  'src/selected/controllers/scalars.controller.ts': `import { Controller, Query, Param, Body, ParseIntPipe as IntegerPipe } from '@nestjs/common';
type Id = string;
type SpaceTypeValue = 'ROOM' | 'HALLWAY';
enum Kind { First = 'first', Second = 'second' }
@Controller('selected') export class ScalarsController {
read(@Param('id') id: Id, @Query('type') type?: SpaceTypeValue, @Query('kind') kind?: Kind, @Body('flag') flag?: boolean | null, @Body('sequence') sequence?: bigint) { return { id, type, kind, flag, sequence }; }
count(@Query('limit', new IntegerPipe()) limit: number): number { return limit; }
direct(@Query('limit', IntegerPipe) limit: number): number { return limit; }
}`,
  'src/selected/controllers/arrays.controller.ts': `import { Controller, Query, Body } from '@nestjs/common';
type Names = readonly string[];
@Controller('arrays') export class ArraysController {
read(@Query('names') names: Names, @Body('values') values: number[], @Body('tuple') tuple: readonly [string, number, boolean?], @Body('empty') empty: readonly []) { return { names, values, tuple, empty }; }
}`,
  'src/selected/controllers/owned.controller.ts': `import { Controller, Body, Req, Res, UploadedFile } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PayloadDto, type ManualDto } from '../dto/payload-request.dto.js';
import { TextPipe } from '../pipes/text.pipe.js';
import { ManualPipe } from '../pipes/manual.pipe.js';
@Controller('owned') export class OwnedController {
read(@Body('payload') payload: PayloadDto): PayloadDto { return payload; }
manual(@Body('payload') payload: ManualDto): ManualDto { return payload; }
whole(@Body() payload: ManualDto): ManualDto { return payload; }
empty(@Body('') payload: PayloadDto): PayloadDto { return payload; }
text(@Body('value', new TextPipe()) value: string): string { return value; }
transformed(@Body('payload', new ManualPipe()) payload: ManualDto): ManualDto { return payload; }
raw(@Req() request: Request, @Res() response: Response, @UploadedFile() file: unknown): void { void file; response.end(request.headers.range); }
}`,
  'src/selected/controllers/inline.controller.ts': `import { Controller, Body } from '@nestjs/common';
@Controller('inline') export class InlineController { read(@Body('payload') payload: { admin: boolean }) { return payload; } }`,
  'src/selected/controllers/record.controller.ts': `import { Controller, Query } from '@nestjs/common';
@Controller('record') export class RecordController { read(@Query('filter') filter: Record<string, string>) { return filter; } }`,
  'src/selected/controllers/service.controller.ts': `import { Controller, Body } from '@nestjs/common';
import { GoodService as Renamed } from '../../demo/services/good.service.js';
@Controller('service') export class ServiceController { read(@Body('payload') payload: Renamed) { return payload; } }`,
  'src/selected/controllers/namespace.controller.ts': `import { Controller, Query } from '@nestjs/common';
import * as services from '../../demo/services/good.service.js';
@Controller('namespace') export class NamespaceController { read(@Query('filter') filter: services.GoodService) { return filter; } }`,
  'src/selected/controllers/objects.controller.ts': `import { Controller, Body } from '@nestjs/common';
@Controller('objects') export class ObjectsController { read(@Body('items') items: { id: string }[]) { return items; } }`,
  'src/selected/controllers/nested.controller.ts': `import { Controller, Body } from '@nestjs/common';
@Controller('nested') export class NestedController { read(@Body('items') items: string[][]) { return items; } }`,
  'src/selected/controllers/mixed.controller.ts': `import { Controller, Body } from '@nestjs/common';
@Controller('mixed') export class MixedController { read(@Body('payload') payload: string | { id: string }) { return payload; } }`,
  'src/selected/controllers/metadata.controller.ts': `import { Controller, Body } from '@nestjs/common';
import type { PayloadDto } from '../dto/payload-request.dto.js';
@Controller('metadata') export class MetadataController { read(@Body('payload') payload: PayloadDto) { return payload; } }`,
  'src/selected/controllers/unknown.controller.ts': `import { Controller, Query } from '@nestjs/common';
@Controller('unknown') export class UnknownController { read(@Query('filter') filter: unknown): unknown { return filter; } }`,
  'src/selected/controllers/any.controller.ts': `import { Controller, Body } from '@nestjs/common';
type Unsafe = ReturnType<typeof JSON.parse>;
@Controller('any') export class AnyController { read(@Body('payload') payload: Unsafe): unknown { return payload; } }`,
  'src/selected/controllers/generic.controller.ts': `import { Controller, Body } from '@nestjs/common';
@Controller('generic') export class GenericController { read<T>(@Body('payload') payload: T): T { return payload; } }`,
  'src/selected/controllers/empty.controller.ts': `import { Controller, Body } from '@nestjs/common';
@Controller('empty') export class EmptyController { read(@Body('') payload: string): string { return payload; } }`,
  'src/selected/controllers/fake-pipe.controller.ts': `import { Controller, Body, type PipeTransform } from '@nestjs/common';
declare const fake: PipeTransform;
@Controller('fake') export class FakePipeController { read(@Body('payload', fake) payload: { id: string }) { return payload; } }`,
  'src/selected/controllers/pipe-output.controller.ts': `import { Controller, Body } from '@nestjs/common';
import { ObjectPipe } from '../pipes/object.pipe.js';
@Controller('output') export class PipeOutputController { read(@Body('payload', new ObjectPipe()) payload: string): string { return payload; } }`,
  'src/selected/controllers/pipe-factory.controller.ts': `import { Controller, Body, type PipeTransform } from '@nestjs/common';
declare function makePipe(): PipeTransform<string, string>;
@Controller('factory') export class PipeFactoryController { read(@Body('payload', makePipe()) payload: string): string { return payload; } }`,
  'src/selected/controllers/erased-pipe.controller.ts': `import { Controller, Body } from '@nestjs/common';
import { ErasedPipe } from '../pipes/erased.pipe.js';
@Controller('erased-pipe') export class ErasedPipeController { read(@Body('payload', new ErasedPipe()) payload: string): string { return payload; } }`,
  'src/forward/setup.ts': `import type { INestApplication } from '@nestjs/common';
import { json, type Request, type Response, type NextFunction, type Application } from 'express';
export type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface.js';
export function setupCors(app: INestApplication): void {
const target = app;
target.enableCors({ origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) { callback(null, origin === undefined || origin === 'https://allowed.invalid'); }, credentials: true });
}
export function setupJson(app: INestApplication): void {
app.use(json({ verify(_request, _response, bytes) { const value: unknown = JSON.parse(bytes.toString('utf8')); if (value === null) throw new Error('null'); } }));
app.use((error: unknown, _request: Request, response: Response, next: NextFunction): void => {
if (!(error instanceof Error)) { next(error); return; }
response.status(400).json({ error: error.message });
});
}
export function setupProxy(app: INestApplication): void {
const instance: unknown = app.getHttpAdapter().getInstance();
const expressApp = instance as Application;
expressApp.set('trust proxy', '172.30.0.0/24');
}`,
  'src/forward/start.ts': `import { NestFactory as Factory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { setupCors as cors, setupJson, setupProxy } from './setup.js';
export async function start(): Promise<void> {
const app = await Factory.create(AppModule, { bodyParser: false });
const alias = app;
cors(alias); setupJson(app); setupProxy(app);
}`,
  'src/forward/fake.ts': `import type { INestApplication } from '@nestjs/common';
declare const forged: INestApplication;
function configure(app: INestApplication): void { app.enableCors({}); }
export function start(): void { configure(forged); }`,
  'src/forward/fake-middleware.ts': `import type { Response, NextFunction } from 'express';
export function wrong(response: Response, next: NextFunction): void { response.status(400); next(); }`,
  'src/forward/fake-json.ts': `import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { json } from 'express';
import { AppModule } from '../app.module.js';
declare const fakeJson: typeof json;
function configure(app: INestApplication): void { app.use(fakeJson()); }
export async function start(): Promise<void> { const app = await NestFactory.create(AppModule); configure(app); }`,
  'src/forward/fake-callee.ts': `import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
function configure(app: INestApplication): void { app.enableCors({}); }
declare const disguised: typeof configure;
export async function start(): Promise<void> { const app = await NestFactory.create(AppModule); configure(app); disguised(app); }`,
  'src/forward/unknown.ts': `import type { INestApplication } from '@nestjs/common';
declare function produce(): INestApplication;
function configure(app: INestApplication): void { app.enableCors({}); }
export function start(): void { const app = produce(); configure(app); }`,
  'src/forward/custom.ts': `import type { INestApplication } from '@nestjs/common';
import { NestFactory, type AbstractHttpAdapter } from '@nestjs/core';
import { AppModule } from '../app.module.js';
declare const adapter: AbstractHttpAdapter;
function configure(app: INestApplication): void { app.enableCors({}); }
export async function start(): Promise<void> { const app = await NestFactory.create(AppModule, adapter); configure(app); }`,
  'src/forward/callback.ts': `import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
function configure(app: INestApplication, opaque: () => void): void {
app.enableCors({ origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) { void origin; void callback; opaque(); } });
}
export async function start(): Promise<void> { const app = await NestFactory.create(AppModule); configure(app, () => undefined); }`,
  'src/forward/business.ts': `import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { unlink } from 'node:fs/promises';
import { request } from 'node:https';
import { execFile } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../app.module.js';
function configure(app: INestApplication): void {
app.enableCors({ origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
callback(null, origin === undefined);
void unlink('not-executed');
request('https://not-executed.invalid');
execFile('not-executed');
const client = new PrismaClient();
void client.facility.findMany();
} });
}
export async function start(): Promise<void> { const app = await NestFactory.create(AppModule); configure(app); }`,
  'src/forward/two-edges.ts': `import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
function inner(app: INestApplication): void { app.enableCors({}); }
function outer(app: INestApplication): void { inner(app); }
export async function start(): Promise<void> { const app = await NestFactory.create(AppModule); outer(app); }`,
  'src/forward/forged-proxy.ts': `import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Application } from 'express';
import { AppModule } from '../app.module.js';
declare const forged: unknown;
function configure(app: INestApplication): void {
app.enableCors({});
const expressApp = forged as Application;
expressApp.set('trust proxy', '172.30.0.0/24');
}
export async function start(): Promise<void> { const app = await NestFactory.create(AppModule); configure(app); }`,
  'src/transport/controllers/events.controller.ts': `import { Controller as Route, Get, Header, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
@Route('events') export class EventsController {
@Get() @Header('content-type', 'text/event-stream')
stream(@Req() request: Request, @Res() response: Response): void {
const output = response;
output.setHeader('cache-control', 'no-cache');
output.flushHeaders();
const heartbeat = setInterval(() => output.write(': heartbeat\\n\\n'), 20_000);
const cleanup = () => { clearInterval(heartbeat); output.end(); };
request.socket.on('close', cleanup);
request.on('close', cleanup);
}
}`,
  'src/transport/controllers/not-sse.controller.ts': `import { Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
@Controller('not-sse') export class NotSseController {
run(@Req() _request: Request, @Res() _response: Response): void { void _request; void _response; setInterval(() => undefined, 1); }
}`,
  'src/transport/controllers/spoof.controller.ts': `import { Controller, Header, Req, Res } from '@nestjs/common';
interface Request { marker: string; }
interface Response { marker: string; }
@Controller('spoof') export class SpoofController {
@Header('content-type', 'text/event-stream')
run(@Req() _request: Request, @Res() _response: Response): void { void _request; void _response; setInterval(() => undefined, 1); }
}`,
  'src/transport/controllers/outbound.controller.ts': `import { Controller, Header, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { request as outbound } from 'node:https';
@Controller('outbound') export class OutboundController {
@Header('content-type', 'text/event-stream')
run(@Req() _request: Request, @Res() _response: Response): void { void _request; void _response; outbound('https://not-executed.invalid'); }
}`,
  'src/transport/controllers/disguised.controller.ts': `import { Controller, Header, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
@Controller('disguised') export class DisguisedController {
@Header('content-type', 'text/event-stream')
run(@Req() request: Request, @Res() _response: Response): void {
void _response;
const disguised = { socket: request.socket };
disguised.socket.connect(1234);
}
}`,
  'src/composition/renamed.ts': `import { NestFactory as Factory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { AppModule } from '../app.module.js';
export async function launch(document: OpenAPIObject): Promise<void> {
const app = await Factory.create(AppModule, { bodyParser: false });
app.setGlobalPrefix('api');
app.useGlobalPipes(new ValidationPipe({ transform: true }));
SwaggerModule.setup('docs', app, document);
await app.listen(8080);
}`,
  'src/main.ts': `import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module.js';
declare const NestFactory: { create(module: unknown): Promise<INestApplication> };
export async function launch(): Promise<void> {
const app = await NestFactory.create(AppModule);
await app.listen(8080);
}`,
  'src/composition/typed-fake.ts': `import type { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
declare const forged: typeof NestFactory;
export async function launch(): Promise<void> {
const app = await forged.create(AppModule);
await app.listen(8080);
}`,
  'src/composition/query.ts': `import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../app.module.js';
export async function launch(): Promise<void> {
const app = await NestFactory.create(AppModule);
const client = new PrismaClient();
await client.facility.findMany();
await app.listen(8080);
}`,
  'src/composition/files.ts': `import { NestFactory } from '@nestjs/core';
import { unlink as remove } from 'node:fs/promises';
import { AppModule } from '../app.module.js';
export async function launch(): Promise<void> {
const app = await NestFactory.create(AppModule);
await remove('not-executed');
await app.listen(8080);
}`,
  'src/files/errors/storage.error.ts': `export class StorageFailure extends Error {}`,
  'src/files/repositories/immutable.repository.ts': `import { promises as disk } from 'node:fs';
import { createHash } from 'node:crypto';
import { StorageFailure } from '../errors/storage.error.js';
export async function publish(staged: string, destination: string, expected: string): Promise<string> {
try { await disk.link(staged, destination); }
catch (error) { if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EEXIST') throw error; }
const handle = await disk.open(destination, 'r');
try {
const stat = await handle.stat();
if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new StorageFailure('invalid file');
const hash = createHash('sha256');
for await (const chunk of handle.createReadStream({ autoClose: false })) {
const value: unknown = chunk;
if (!(value instanceof Uint8Array)) throw new StorageFailure('invalid bytes');
hash.update(value);
}
const actual = hash.digest('hex');
if (actual !== expected) throw new StorageFailure('immutable conflict');
await handle.sync();
return actual;
} finally { await handle.close(); }
}
export async function discard(staged: string): Promise<void> { await disk.unlink(staged); }`,
  'src/files/repositories/file.repository.ts': `import { Injectable } from '@nestjs/common';
import { unlink as remove } from 'node:fs/promises';
@Injectable() export class FileRepository { async discard(path: string): Promise<void> { await remove(path); } }`,
  'src/files/helpers/alias.helper.ts': `import { unlink as remove } from 'node:fs/promises';
export async function discard(path: string): Promise<void> { await remove(path); }`,
  'src/files/config/disk.config.ts': `import * as disk from 'node:fs/promises';
export async function discard(path: string): Promise<void> { await disk.unlink(path); }`,
  'src/files/helpers/wrong.repository.ts': `import { unlink } from 'node:fs/promises';
export async function discard(path: string): Promise<void> { await unlink(path); }`,
  'src/files/repositories/no-export.repository.ts': `import { unlink } from 'node:fs/promises';
void unlink('not-executed');`,
  'src/files/misplaced.repository.ts': `import { Injectable } from '@nestjs/common';
import { unlink } from 'node:fs/promises';
@Injectable() export class MisplacedRepository { async discard(path: string): Promise<void> { await unlink(path); } }`,
  'src/files/repositories/network.repository.ts': `import { request as send } from 'node:https';
export function connect(url: string) { return send(url); }`,
  'src/files/repositories/alias.repository.ts': `import { request } from 'node:https';
export const send = request;
export function connect(url: string) { return send(url); }`,
  'src/files/repositories/process.repository.ts': `import * as processApi from 'node:child_process';
export function execute() { return processApi.execFile('not-executed'); }`,
  'src/files/repositories/timer.repository.ts': `import { setTimeout as wait } from 'node:timers/promises';
export async function retry(): Promise<void> { await wait(1); }`,
  'src/files/repositories/http.repository.ts': `import type { Response } from 'express';
export function send(response: Response): void { response.status(204); }`,
  'src/review/helpers/config.helper.ts': `import type { ConfigService } from '@nestjs/config';
export function readPositive(config: ConfigService, key: string, fallback: number): number {
const value = config.get<string | number>(key);
if (typeof value === 'number' && value > 0) return Math.trunc(value);
if (typeof value === 'string') { const parsed = Number(value); if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed); }
return fallback;
}
export function readRequired(config: ConfigService, key: string): string { return config.getOrThrow<string>(key).trim(); }`,
  'src/review/helpers/spoof.helper.ts': `interface ConfigService { get<T>(key: string): T; getOrThrow<T>(key: string): T; }
export function read(config: ConfigService): string { return config.get<string>('key'); }
export function required(config: ConfigService): string { return config.getOrThrow<string>('key'); }`,
  'src/review/errors/json.error.ts': `export class StrictJsonError extends Error { readonly name = 'StrictJsonError'; }`,
  'src/review/helpers/json.helper.ts': `import { TextDecoder } from 'node:util';
import { StrictJsonError } from '../errors/json.error.js';
export class JsonReader {
constructor(readonly text: string) {}
read(): unknown { if (!this.text.trim()) throw new StrictJsonError('blank'); return JSON.parse(this.text); }
}
export function parse(bytes: Uint8Array): { value: unknown; original: Buffer } {
const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const seen = new Set<string>(); seen.add(text);
if (/invalid/.test(text) || !seen.has(text)) throw new StrictJsonError('invalid');
return { value: new JsonReader(text).read(), original: Buffer.from(bytes) };
}`,
  'src/review/misplaced.service.ts': `import { Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
@Injectable() export class FileService { read(path: string): Promise<string> { return readFile(path, 'utf8'); } }`,
  'src/review/misplaced.controller.ts': `import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
@Controller('transport') export class TransportController { @Get() send(@Res() response: Response): void { response.status(200).end(); } }`,
  'src/review/services/upload.service.ts': `import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
@Injectable() export class UploadService { upload(id: string, request: Request): string { return id + String(request.headers['content-type'] ?? ''); } }`,
  'src/review/controllers/upload.controller.ts': `import { Controller, Put, Param, Req, HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { UploadService } from '../services/upload.service.js';
@Controller('upload') export class UploadController {
constructor(readonly service: UploadService) {}
@Put(':id') upload(@Param('id') id: string, @Req() request: Request): string {
try { return this.service.upload(id, request); } catch (error) { throw mapError(error); }
}
}
function mapError(error: unknown): Error { return error instanceof Error ? error : new HttpException('upload failed', 500); }`,
  'src/review/controllers/network.controller.ts': `import { Controller } from '@nestjs/common';
import { request } from 'node:https';
@Controller('network') export class NetworkController { connect(url: string) { return request(url); } }`,
  'src/pure/helpers/json.helper.ts': `import { createHash } from 'node:crypto';
export class JsonReader {
constructor(readonly text: string) {}
read(): string {
const parsed: unknown = JSON.parse(this.text);
return typeof parsed === 'string' ? parsed.trim() : '';
}
}
export function digest(value: string): string {
return createHash('sha256').update(Buffer.from(value)).digest('hex');
}`,
  'src/pure/errors/domain.error.ts': `export class DomainFailure extends Error {
constructor(message: string) { super(message); this.name = 'DomainFailure'; }
}`,
  'src/pure/helpers/lookalike.helper.ts': `function readFile(path: string): string { return path.toUpperCase(); }
function fetch(path: string): string { return path.trim(); }
export function compute(value: string): string { return fetch(readFile(value)); }`,
  'src/pure/repositories/functional.repository.ts': `import type { PrismaClient } from '@prisma/client';
export function readRows(client: PrismaClient) { return client.facility.findMany(); }`,
  'src/pure/services/functional.service.ts': `import { readFile } from 'node:fs/promises';
export function load(path: string): Promise<string> { return readFile(path, 'utf8'); }`,
  'src/pure/services/repository-consumer.service.ts': `import type { PrismaClient } from '@prisma/client';
import { readRows } from '../repositories/functional.repository.js';
export function list(client: PrismaClient) { return readRows(client); }`,
  'src/pure/repositories/signature.repository.ts': `import type { PrismaClient } from '@prisma/client';
type RowReader = (client: PrismaClient) => Promise<unknown>;
export function readPage(client: PrismaClient, page: 1): Promise<unknown>;
export function readPage(client: PrismaClient, page: number): Promise<unknown>;
export function readPage(client: PrismaClient, page: number): Promise<unknown> { return client.facility.findMany({ take: page }); }
export const listRows: RowReader = (client) => client.facility.findMany();`,
  'src/pure/services/signature-consumer.service.ts': `import type { PrismaClient } from '@prisma/client';
import { listRows, readPage } from '../repositories/signature.repository.js';
export function page(client: PrismaClient): Promise<unknown> { return readPage(client, 1); }
export function rows(client: PrismaClient): Promise<unknown> { return listRows(client); }`,
  'src/pure/adapters/functional.adapter.ts': `import { request } from 'node:https';
export function connect(url: string) { return request(url); }`,
  'src/pure/helpers/database.helper.ts': `import type { PrismaClient } from '@prisma/client';
export function readRows(client: PrismaClient) { return client.facility.findMany(); }`,
  'src/pure/renamed.ts': `import { PrismaClient as Client } from '@prisma/client';
export function open() { return new Client(); }`,
  'src/pure/config/database.config.ts': `import * as generated from '@prisma/client';
export function configuration() { return new generated.PrismaClient(); }`,
  'src/pure/helpers/network.helper.ts': `import { request as send } from 'node:https';
export function connect(url: string) { return send(url); }`,
  'src/pure/helpers/namespace.helper.ts': `import * as files from 'node:fs/promises';
export function load(path: string): Promise<string> { return files.readFile(path, 'utf8'); }`,
  'src/pure/helpers/process.helper.ts': `import { execFile as execute } from 'node:child_process';
export function run() { return execute('not-executed'); }`,
  'src/pure/helpers/timer.helper.ts': `export function schedule() { return setTimeout(() => undefined, 1); }`,
  'src/pure/helpers/fetch.helper.ts': `export function download(url: string) { return fetch(url); }`,
  'src/pure/helpers/opaque.helper.ts': `export function produce(callback: () => string): string { return callback(); }`,
  'src/pure/wrong-reader.ts': `export class Reader { read(value: string): string { return value.trim(); } }`,
  'src/pure/wrong-error.ts': `export class DomainFailure extends Error {}`,
  'src/pure/helpers/registered.helper.ts': `import { Injectable } from '@nestjs/common';
@Injectable() export class Reader { read(value: string): string { return value.trim(); } }`,
  'src/pure/repositories/local-http.repository.ts': `import { ForbiddenException as Base } from '@nestjs/common';
export class LocalDenied extends Base {}
export function deny(): never { throw new LocalDenied(); }`,
  'src/factory/services/inspector.service.ts': `export class InspectorService { inspect(): string { return 'inspected'; } }`,
  'src/factory/services/storage.service.ts': `import type { InspectorService } from './inspector.service.js';
export class StorageService {
constructor(readonly options: { inspector: InspectorService; enabled: boolean }) {}
read(): string { return this.options.inspector.inspect(); }
}`,
  'src/factory/services/reconciler.service.ts': `import type { StorageService } from './storage.service.js';
export class ReconcilerService {
constructor(readonly options: { storage: StorageService; enabled: boolean }) {}
read(): string { return this.options.storage.read(); }
}`,
  'src/factory/config.ts': `export const INTERVAL = Symbol('interval');
export const CONFIG = Symbol('config');
export const DEFAULT_INTERVAL = 20_000;
export interface Config { enabled: boolean; directory: string; }
export function readConfig(): Config {
const enabled = process.env.FEATURE_ENABLED === 'true';
return { enabled, directory: process.env.CLIP_DIR ?? '/tmp/fixture' };
}`,
  'src/factory/factory.module.ts': `import { Module } from '@nestjs/common';
import { InspectorService } from './services/inspector.service.js';
import { StorageService } from './services/storage.service.js';
import { ReconcilerService } from './services/reconciler.service.js';
import { INTERVAL, CONFIG, DEFAULT_INTERVAL, readConfig } from './config.js';
@Module({ providers: [
InspectorService,
{ provide: INTERVAL, useValue: DEFAULT_INTERVAL },
{ provide: 'plain-config', useValue: { enabled: true, directory: '/tmp/fixture' } },
{ provide: CONFIG, useFactory: readConfig },
{ provide: StorageService, inject: [InspectorService], useFactory: (inspector: InspectorService): StorageService => new StorageService({ inspector, enabled: readConfig().enabled }) },
{ provide: ReconcilerService, inject: [StorageService], useFactory: (storage: StorageService): ReconcilerService => new ReconcilerService({ storage, enabled: process.env.FEATURE_ENABLED === 'true' }) }
] }) export class FactoryModule {}`,
  'src/factory/named.ts': `import { StorageService } from './services/storage.service.js';
import type { InspectorService } from './services/inspector.service.js';
export function createStorage(inspector: InspectorService): StorageService {
return new StorageService({ inspector, enabled: true });
}`,
  'src/factory/named.module.ts': `import { Module } from '@nestjs/common';
import { InspectorService } from './services/inspector.service.js';
import { StorageService } from './services/storage.service.js';
import { createStorage } from './named.js';
@Module({ providers: [{ provide: StorageService, inject: [InspectorService], useFactory: createStorage }] }) export class NamedModule {}`,
  'src/factory/callable-value.module.ts': `import { Module } from '@nestjs/common';
@Module({ providers: [{ provide: 'callable', useValue: () => 1 }] }) export class CallableValueModule {}`,
  'src/factory/opaque.module.ts': `import { Module } from '@nestjs/common';
import type { StorageService } from './services/storage.service.js';
declare function external(): StorageService;
function opaque(): StorageService { return external(); }
@Module({ providers: [{ provide: 'opaque', useFactory: opaque }] }) export class OpaqueModule {}`,
  'src/factory/erased.module.ts': `import { Module } from '@nestjs/common';
import { InspectorService } from './services/inspector.service.js';
@Module({ providers: [{ provide: 'erased', useFactory: (): unknown => new InspectorService() }] }) export class ErasedModule {}`,
  'src/factory/spread.module.ts': `import { Module } from '@nestjs/common';
const binding = { provide: 'spread', useValue: 1 };
@Module({ providers: [{ ...binding }] }) export class SpreadModule {}`,
  'src/factory/computed.module.ts': `import { Module } from '@nestjs/common';
const key = 'useValue';
@Module({ providers: [{ provide: 'computed', [key]: 1 }] }) export class ComputedModule {}`,
  'src/factory/nonclass.module.ts': `import { Module } from '@nestjs/common';
@Module({ providers: [42] }) export class NonclassModule {}`,
  'src/factory/fake.module.ts': `function Module(_metadata: unknown): ClassDecorator { return () => undefined; }
@Module({ providers: [] }) export class FakeModule {}`,
  'src/factory/services/dual.service.ts': `export class DualService { constructor(readonly options: { enabled: boolean }) {} }`,
  'src/factory/dual.module.ts': `import { Module } from '@nestjs/common';
import { DualService } from './services/dual.service.js';
@Module({ providers: [DualService, { provide: 'manual-dual', useFactory: (): DualService => new DualService({ enabled: true }) }] }) export class DualModule {}`,
  'src/common/errors.ts': `export class MissingTenantContextError extends Error {
constructor(model: string, operation: string) { super(model + operation); }
}`,
  'src/common/tenant-context.ts': `export class TenantContext {
static getBoundFacilityId(): string | undefined { return undefined; }
static runBound<T>(_facility: string, fn: () => T): T { return fn(); }
}`,
  'src/demo/repositories/prisma-members.repository.ts': `import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
@Injectable() export class PrismaMembersRepository {
constructor(readonly prisma: PrismaService) {}
read() { return this.prisma.db.facility.findMany(); }
scoped() { return this.prisma.withFacilityContext('fixture', (tx) => tx.facility.findMany()); }
}`,
  'src/demo/controllers/model-data.controller.ts': `import { Controller } from '@nestjs/common';
import type { Event, Alert } from '@prisma/client';
@Controller('data') export class ModelDataController {
present(event: Event, alert: Alert) {
return { id: event.id, facilityId: event.facilityId, confidence: event.confidence, createdAt: event.createdAt, sequence: alert.alertSeq, status: alert.status };
}
}`,
  'src/demo/services/model.service.ts': `import { Injectable } from '@nestjs/common';
import type { Event } from '@prisma/client';
@Injectable() export class ModelService { read(event: Event): Event { return event; } }`,
  'src/demo/controllers/returned-data.controller.ts': `import { Controller } from '@nestjs/common';
import type { Event } from '@prisma/client';
import { ModelService } from '../services/model.service.js';
@Controller('returned') export class ReturnedDataController {
constructor(readonly service: ModelService) {}
present(event: Event) { const result = this.service.read(event); return { id: result.id, facilityId: result.facilityId, at: result.detectedAt }; }
}`,
  'src/demo/controllers/query.controller.ts': `import { Controller } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
@Controller('query') export class QueryController { read(client: PrismaClient) { return client.facility.findMany(); } }`,
  'src/demo/controllers/client.controller.ts': `import { Controller } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
@Controller('client') export class ClientController { create() { return new PrismaClient(); } }`,
  'src/demo/repositories/noninfra-member.repository.ts': `import { Injectable } from '@nestjs/common';
import type { BusinessService } from '../../prisma/business.service.js';
@Injectable() export class NoninfraMemberRepository { read(service: BusinessService): string { return service.read(); } }`,
  'src/demo/repositories/samefile-member.repository.ts': `import { Injectable } from '@nestjs/common';
import type { NeighborService } from '../../prisma/prisma.service.js';
@Injectable() export class SamefileMemberRepository { read(service: NeighborService): string { return service.read(); } }`,
  'src/app.module.ts': `import { Module } from '@nestjs/common';
@Module({}) export class AppModule {}`,
  'src/feature/feature.module.ts': `import * as nest from '@nestjs/common';
@nest.Module({}) export class FeatureModule {}`,
  'src/demo/controllers/wrong-name.controller.ts': `import { Controller } from '@nestjs/common';
@Controller('wrong-name') export class WrongName {}`,
  'src/demo/services/wrong-name.service.ts': `import { Injectable } from '@nestjs/common';
@Injectable() export class WrongName {}`,
  'src/demo/repositories/wrong-name.repository.ts': `import { Injectable } from '@nestjs/common';
@Injectable() export class WrongName {}`,
  'src/demo/controllers/lowercase.controller.ts': `import { Controller } from '@nestjs/common';
@Controller('lowercase') export class lowercaseController {}`,
  'src/demo/wrong-name.module.ts': `import { Module } from '@nestjs/common';
@Module({}) export class Wrong {}`,
  'src/demo/wrong-file.ts': `import { Module } from '@nestjs/common';
@Module({}) export class WrongFileModule {}`,
  'src/demo/helpers/hidden.module.ts': `import { Module } from '@nestjs/common';
@Module({}) export class HiddenModule {}`,
  'src/demo/services/hidden.module.ts': `import { Module } from '@nestjs/common';
@Module({}) export class HiddenModule {}`,
  'src/demo/dto/hidden.module.ts': `import { Module } from '@nestjs/common';
@Module({}) export class HiddenModule {}`,
  'src/helpers/hidden.module.ts': `import { Module } from '@nestjs/common';
@Module({}) export class HiddenModule {}`,
  'src/other.module.ts': `import { Module } from '@nestjs/common';
@Module({}) export class OtherModule {}`,
  'src/demo/repositories/warehouse.ts': `import { Injectable } from '@nestjs/common';
@Injectable() export class Warehouse { read(): string { return 'stored'; } }`,
  'src/demo/controllers/warehouse.controller.ts': `import { Controller } from '@nestjs/common';
import { Warehouse } from '../repositories/warehouse.js';
@Controller('warehouse') export class WarehouseController { constructor(readonly storage: Warehouse) {} }`,
  'foreign/src/demo/dto/counterfeit-request.dto.ts': `export class CounterfeitDto { id?: string; }`,
  'src/demo/controllers/counterfeit.controller.ts': `import { Controller, Body, Post } from '@nestjs/common';
import { CounterfeitDto } from '../../../foreign/src/demo/dto/counterfeit-request.dto.js';
@Controller('counterfeit') export class CounterfeitController { @Post() create(@Body() body: CounterfeitDto): CounterfeitDto { return body; } }`,
  'src/demo/services/controller.service.ts': `import { Injectable } from '@nestjs/common';
import { GoodController } from '../controllers/good.controller.js';
@Injectable() export class ControllerService { constructor(readonly controller: GoodController) {} }`,
  'src/demo/controller-barrel.ts': `export { GoodController as Endpoint } from './controllers/good.controller.js';`,
  'src/demo/services/controller-alias.service.ts': `import { Injectable } from '@nestjs/common';
import { Endpoint as Hidden } from '../controller-barrel.js';
@Injectable() export class ControllerAliasService { constructor(readonly endpoint: Hidden) {} }`,
  'src/demo/services/repository.service.ts': `import { Injectable } from '@nestjs/common';
import { GoodRepository } from '../repositories/good.repository.js';
@Injectable() export class RepositoryService { constructor(readonly repository: GoodRepository) {} }`,
  'src/demo/dto/existing-request.dto.ts': `export class ExistingDto { optional?: string; }`,
  'src/demo/controllers/existing.controller.ts': `import { Controller, Body, Post } from '@nestjs/common';
import { ExistingDto } from '../dto/existing-request.dto.js';
@Controller('existing') export class ExistingController { @Post() create(@Body() body: ExistingDto): ExistingDto { return body; } }`,
  'src/demo/dto/legacy.dto.ts': `export class LegacyRequestDto { optional?: string; }`,
  'src/demo/controllers/legacy.controller.ts': `import { Controller, Body, Post } from '@nestjs/common';
import { LegacyRequestDto } from '../dto/legacy.dto.js';
@Controller('legacy') export class LegacyController { @Post() create(@Body() body: LegacyRequestDto): LegacyRequestDto { return body; } }`,
  'src/demo/controllers/wrong-role.controller.ts': `import { Controller, Body, Post } from '@nestjs/common';
import type { FilterQueryDto } from '../dto/filter-query.dto.js';
@Controller('wrong') export class WrongRoleController { @Post() create(@Body() body: FilterQueryDto): FilterQueryDto { return body; } }`,
  'src/demo/dto/service-request.dto.ts': `import { GoodService as Hidden } from '../services/good.service.js';
export class ServiceRequestDto { dependency = new Hidden(); }`,
  'src/demo/dto/repository-request.dto.ts': `import * as storage from '../repositories/good.repository.js';
export class RepositoryRequestDto { dependency = new storage.GoodRepository(); }`,
  'src/demo/dto/interface-request.dto.ts': `import type { GoodController } from '../controllers/good.controller.js';
export interface InterfaceRequestDto { endpoint: GoodController; }`,
  'src/demo/dto/reexport-request.dto.ts': `export { GoodService as Hidden } from '../services/good.service.js';
export interface ReexportRequestDto { id: string; }`,
  'src/demo/dto/barrel-request.dto.ts': `import { Hidden } from '../barrel.js';
export class BarrelRequestDto { dependency = new Hidden(); }`,
  'src/demo/dto/prisma-request.dto.ts': `import { PrismaClient } from '@prisma/client';
export class PrismaRequestDto { dependency = new PrismaClient(); }`,
  'src/demo/dto/infra-request.dto.ts': `import type { PrismaService } from '../../prisma/prisma.service.js';
export interface InfraRequestDto { dependency: PrismaService; }`,
  'src/demo/dto/provider-request.dto.ts': `export class ProviderRequestDto { value(): string { return 'provider'; } }`,
  'src/demo/provider.module.ts': `import { Module } from '@nestjs/common';
import { ProviderRequestDto } from './dto/provider-request.dto.js';
@Module({ providers: [ProviderRequestDto] }) export class ProviderModule {}`,
  'src/demo/dto/enum-request.dto.ts': `import { Role as UserRole } from '@prisma/client';
import type { Facility } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateRequestDto } from './create-request.dto.js';
export class EnumRequestDto {
@ApiProperty({ enum: UserRole }) @IsEnum(UserRole) role!: UserRole;
@ValidateNested() @Type(() => CreateRequestDto) nested!: CreateRequestDto;
facility?: Facility;
}`,
  'src/demo/dto/namespace-enum-request.dto.ts': `import * as generated from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';
export class NamespaceEnumRequestDto {
@ApiProperty({ enum: generated.Role }) role!: generated.Role;
}`,
  'src/demo/repositories/prisma.repository.ts': `import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
@Injectable() export class PrismaRepository { constructor(readonly prisma: PrismaService) {} }`,
  'src/demo/controllers/prisma.controller.ts': `import { Controller } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
@Controller('prisma') export class PrismaController { constructor(readonly prisma: PrismaService) {} }`,
  'src/prisma/business.service.ts': `import { Injectable } from '@nestjs/common';
@Injectable() export class BusinessService { read(): string { return 'not infrastructure'; } }`,
  'src/demo/repositories/hidden.repository.ts': `import { Injectable } from '@nestjs/common';
import { BusinessService } from '../../prisma/business.service.js';
@Injectable() export class HiddenRepository { constructor(readonly business: BusinessService) {} }`,
  'src/demo/services/token.service.ts': `import { Injectable, Inject, Optional } from '@nestjs/common';
export interface Port { read(): string; }
export const PORT = Symbol('port');
@Injectable() export class TokenService { constructor(@Optional() @Inject(PORT) readonly port: Port) {} }`,
  'src/demo/services/erased.service.ts': `import { Injectable } from '@nestjs/common';
import type { GoodService } from './good.service.js';
@Injectable() export class ErasedService { constructor(readonly other: GoodService) {} }`,
  'src/demo/services/registered.service.ts': `export class RegisteredService { read(): string { return 'registered'; } }`,
  'src/demo/registered.module.ts': `import { Module } from '@nestjs/common';
import { RegisteredService } from './services/registered.service.js';
@Module({ providers: [RegisteredService] }) export class RegisteredModule {}`,
  'src/demo/type-barrel.ts': `export type { CreateRequestDto } from './dto/create-request.dto.js';`,
  'src/demo/controllers/type-barrel.controller.ts': `import { Controller, Post, Body } from '@nestjs/common';
import { CreateRequestDto } from '../type-barrel.js';
@Controller('bad') export class TypeBarrelController { @Post() create(@Body() body: CreateRequestDto): CreateRequestDto { return body; } }`,
  'src/demo/controllers/computed.controller.ts': `import { Controller, Param, Get } from '@nestjs/common';
const key = 'id';
@Controller('computed') export class ComputedController { @Get(':id') read(@Param(key) id: string): string { return id; } }`,
  'src/demo/controllers/namespace-type.controller.ts': `import { Controller, Post, Body } from '@nestjs/common';
import type * as contract from '../dto/create-request.dto.js';
@Controller('bad') export class NamespaceTypeController { @Post() create(@Body() body: contract.CreateRequestDto): contract.CreateRequestDto { return body; } }`,
  'src/demo/dto/create-request.dto.ts': `export class CreateRequestDto { facility_id?: string; }`,
  'src/demo/dto/filter-query.dto.ts': `export interface FilterQueryDto { cursor?: string; }`,
  'src/demo/dto/result-response.dto.ts': `export type ResultResponseDto = { ok: true } | { error: string };`,
  'src/demo/services/good.service.ts': `import { Injectable } from '@nestjs/common';
@Injectable() export class GoodService { value(): string { return 'ok'; } }`,
  'src/demo/repositories/good.repository.ts': `import { Injectable } from '@nestjs/common';
@Injectable() export class GoodRepository { value(): string { return 'ok'; } }`,
  'src/demo/adapters/good.adapter.ts': `import { Injectable } from '@nestjs/common';
@Injectable() export class GoodAdapter { value(): string { return 'ok'; } }`,
  'src/demo/controllers/good.controller.ts': `import { Controller, Body, Query, Param, Post, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CreateRequestDto as Input } from '../dto/create-request.dto.js';
import type { FilterQueryDto } from '../dto/filter-query.dto.js';
@Controller('demo') export class GoodController {
@Post() create(@Body() input: Input): Input { return input; }
@Get() list(@Query() query: FilterQueryDto): FilterQueryDto { return query; }
@Get(':id') get(@Param('id') id: string): string { return id; }
@Post('raw') raw(@Req() request: Request, @Res() response: Response): void { response.end(request.headers.range); }
}`,
  'src/demo/controllers/alias.controller.ts': `import { Controller as Route, Body as Payload, Post } from '@nestjs/common';
import * as contract from '../dto/create-request.dto.js';
@Route('alias') export class AliasController { @Post() create(@Payload() body: contract.CreateRequestDto): contract.CreateRequestDto { return body; } }`,
  'src/demo/controllers/namespace.controller.ts': `import * as nest from '@nestjs/common';
import { CreateRequestDto } from '../dto/create-request.dto.js';
@nest.Controller('namespace') export class NamespaceController { @nest.Post() create(@nest.Body() body: CreateRequestDto): CreateRequestDto { return body; } }`,
  'src/demo/demo.module.ts': `import { Module } from '@nestjs/common';
import { GoodController } from './controllers/good.controller.js';
import { GoodService } from './services/good.service.js';
@Module({ controllers: [GoodController], providers: [GoodService] }) export class DemoModule {}`,
  'src/demo/controllers/repository.controller.ts': `import { Controller } from '@nestjs/common';
import { GoodRepository as Hidden } from '../repositories/good.repository.js';
@Controller('bad') export class RepositoryController { constructor(readonly repository: Hidden) {} }`,
  'src/demo/barrel.ts': `export { GoodRepository as Hidden } from './repositories/good.repository.js';`,
  'src/demo/controllers/barrel.controller.ts': `import { Controller } from '@nestjs/common';
import { Hidden } from '../barrel.js';
@Controller('bad') export class BarrelController { constructor(readonly repository: Hidden) {} }`,
  'src/demo/controllers/type.controller.ts': `import { Controller } from '@nestjs/common';
import type { GoodRepository } from '../repositories/good.repository.js';
@Controller('bad') export class TypeController { read(value: GoodRepository): string { return value.value(); } }`,
  'src/demo/controllers/namespace-dependency.controller.ts': `import { Controller } from '@nestjs/common';
import * as storage from '../repositories/good.repository.js';
@Controller('bad') export class NamespaceDependencyController { read(): string { return new storage.GoodRepository().value(); } }`,
  'src/demo/repositories/http.repository.ts': `import { Injectable, ForbiddenException as Denied } from '@nestjs/common';
@Injectable() export class HttpRepository { read(): never { throw new Denied(); } }`,
  'src/demo/repositories/namespace-http.repository.ts': `import * as nest from '@nestjs/common';
@nest.Injectable() export class NamespaceHttpRepository { read(): never { throw new nest.ConflictException(); } }`,
  'src/demo/services/adapter.service.ts': `import { Injectable } from '@nestjs/common';
import { GoodAdapter } from '../adapters/good.adapter.js';
@Injectable() export class AdapterService { constructor(readonly adapter: GoodAdapter) {} }`,
  'src/demo/controllers/unsafe.controller.ts': `import { Controller, Body, Post } from '@nestjs/common';
@Controller('bad') export class UnsafeController { @Post() create(@Body() body: unknown): unknown { return body; } }`,
  'src/demo/controllers/anonymous.controller.ts': `import { Controller, Query, Get } from '@nestjs/common';
@Controller('bad') export class AnonymousController { @Get() read(@Query() query: { id: string }): string { return query.id; } }`,
  'src/demo/controllers/metadata.controller.ts': `import { Controller, Body, Post } from '@nestjs/common';
import type { CreateRequestDto } from '../dto/create-request.dto.js';
@Controller('bad') export class MetadataController { @Post() create(@Body() body: CreateRequestDto): CreateRequestDto { return body; } }`,
  'src/demo/dto/alias-request.dto.ts': `import type { CreateRequestDto } from './create-request.dto.js';
export type AliasRequestDto = CreateRequestDto;`,
  'src/demo/controllers/erased.controller.ts': `import { Controller, Body, Post } from '@nestjs/common';
import type { AliasRequestDto } from '../dto/alias-request.dto.js';
@Controller('bad') export class ErasedController { @Post() create(@Body() body: AliasRequestDto): AliasRequestDto { return body; } }`,
  'src/demo/renamed.ts': `import { Controller, Body, Post } from '@nestjs/common';
@Controller('renamed') export class Hidden { @Post() create(@Body() body: unknown): unknown { return body; } }`,
  'src/demo/unknown.ts': `import { Injectable } from '@nestjs/common';
@Injectable() export class Opaque {}`,
  'src/demo/renamed.spec.ts': `import { Controller } from '@nestjs/common';
@Controller('hidden') export class HiddenController {}`,
  'src/demo/controllers/computed-import.controller.ts': `import { Controller } from '@nestjs/common';
import * as storage from '../repositories/good.repository.js';
@Controller('bad') export class ComputedImportController { read(): string { return new storage['GoodRepository']().value(); } }`,
  'src/demo/controllers/dynamic.controller.ts': `import { Controller } from '@nestjs/common';
@Controller('bad') export class DynamicController { load(): Promise<unknown> { return import('../repositories/good.repository.js'); } }`,
  'src/demo/controllers/require.controller.ts': `import { Controller } from '@nestjs/common';
import storage = require('../repositories/good.repository.js');
@Controller('bad') export class RequireController { read(): string { return new storage.GoodRepository().value(); } }`,
  'src/demo/dynamic.module.ts': `import { Module } from '@nestjs/common';
const providers = [];
@Module({ providers }) export class DynamicModule {}`,
  'src/demo/controllers/renamed.controller.mts': `import { Controller, Body, Post } from '@nestjs/common';
@Controller('extension') export class RenamedController { @Post() create(@Body() body: unknown): unknown { return body; } }`,
};

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'seeon-architecture-'));
  await symlink(
    path.join(backend, 'node_modules'),
    path.join(root, 'node_modules'),
    'dir',
  );
  await writeFile(path.join(root, 'package.json'), '{"type":"commonjs"}');
  await writeFile(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        strict: true,
        skipLibCheck: true,
      },
      include: ['src/**/*.ts', 'src/**/*.mts'],
    }),
  );
  // Parse the real infrastructure class as fixture source, never import or run
  // its constructor/lifecycle. Only its local context/error dependencies are doubles.
  fixtures['src/prisma/prisma.service.ts'] =
    (await readFile(
      path.join(backend, 'src/prisma/prisma.service.ts'),
      'utf8',
    )) +
    `
export class NeighborService { read(): string { return 'not infrastructure'; } }
`;
  for (const [file, text] of Object.entries(fixtures)) {
    // Format through the real fixture path: prettier's forced trailing comma
    // for a single-type-parameter arrow function is keyed off the file
    // extension, so a path-less format writes source that the eslint-plugin-
    // prettier pass over the same file would immediately rewrite.
    const target = path.join(root, file);
    const formatted = await format(text, {
      parser: 'typescript',
      filepath: target,
    });
    sources.set(file, formatted);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, formatted);
  }
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

for (const [name, config] of [
  ['main', mainConfig],
  ['dto', dtoConfig],
]) {
  let eslint;
  const lint = async (file) => {
    eslint ??= new ESLint({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: [
        ...config,
        {
          files: ['src/**/*.{ts,mts,cts,tsx,js}'],
          languageOptions: { parserOptions: { tsconfigRootDir: root } },
        },
      ],
    });
    const [result] = await eslint.lintFiles([path.join(root, file)]);
    assert.equal(
      result.messages.some((message) => message.fatal),
      false,
      JSON.stringify(result.messages),
    );
    assert.equal(
      result.messages.some((message) => message.message.includes('ignored')),
      false,
      JSON.stringify(result.messages),
    );
    return result.messages;
  };
  for (const file of [
    'src/demo/controllers/good.controller.ts',
    'src/demo/controllers/alias.controller.ts',
    'src/demo/controllers/namespace.controller.ts',
    'src/demo/services/good.service.ts',
    'src/demo/repositories/good.repository.ts',
    'src/demo/demo.module.ts',
    'src/demo/repositories/prisma.repository.ts',
    'src/demo/services/token.service.ts',
    'src/demo/services/registered.service.ts',
    'src/demo/services/repository.service.ts',
    'src/demo/controllers/existing.controller.ts',
    'src/demo/dto/existing-request.dto.ts',
    'src/demo/dto/enum-request.dto.ts',
    'src/demo/dto/namespace-enum-request.dto.ts',
    'src/app.module.ts',
    'src/feature/feature.module.ts',
    'src/demo/registered.module.ts',
    'src/demo/repositories/prisma-members.repository.ts',
    'src/demo/controllers/model-data.controller.ts',
    'src/demo/controllers/returned-data.controller.ts',
  ]) {
    test(`${name}: legitimate boundary ${file}`, async () => {
      const messages = await lint(file);
      assert.deepEqual(messages, [], JSON.stringify(messages));
    });
  }
  for (const file of [
    'src/factory/factory.module.ts',
    'src/factory/named.module.ts',
    'src/factory/services/inspector.service.ts',
    'src/factory/services/storage.service.ts',
    'src/factory/services/reconciler.service.ts',
  ]) {
    test(`${name}: static provider facts ${file}`, async () => {
      const messages = await lint(file);
      assert.deepEqual(messages, [], JSON.stringify(messages));
    });
  }
  for (const file of [
    'src/pure/helpers/json.helper.ts',
    'src/pure/errors/domain.error.ts',
    'src/pure/helpers/lookalike.helper.ts',
    'src/pure/repositories/functional.repository.ts',
    'src/pure/services/functional.service.ts',
    'src/pure/adapters/functional.adapter.ts',
    'src/pure/services/repository-consumer.service.ts',
    'src/pure/repositories/signature.repository.ts',
    'src/pure/services/signature-consumer.service.ts',
  ]) {
    test(`${name}: bounded functional ownership ${file}`, async () => {
      const messages = await lint(file);
      assert.deepEqual(messages, [], JSON.stringify(messages));
    });
  }
  for (const file of [
    'src/review/helpers/config.helper.ts',
    'src/review/errors/json.error.ts',
    'src/review/helpers/json.helper.ts',
    'src/review/controllers/upload.controller.ts',
  ]) {
    test(`${name}: reviewed computational or transport boundary ${file}`, async () => {
      const messages = await lint(file);
      assert.deepEqual(messages, [], JSON.stringify(messages));
    });
  }
  for (const file of [
    'src/review/misplaced.service.ts',
    'src/review/misplaced.controller.ts',
  ]) {
    test(`${name}: relocation retains semantic ownership ${file}`, async () => {
      const messages = await lint(file);
      assert.equal(messages.length, 1, JSON.stringify(messages));
      assert.equal(messages[0].ruleId, 'architecture/boundaries');
      assert.equal(messages[0].messageId, 'placement');
    });
  }
  for (const file of [
    'src/files/errors/storage.error.ts',
    'src/files/repositories/immutable.repository.ts',
    'src/files/repositories/file.repository.ts',
  ]) {
    test(`${name}: filesystem persistence repository ${file}`, async () => {
      assert.deepEqual(await lint(file), []);
    });
  }
  for (const [file, expectedIds, token] of [
    ['src/files/helpers/alias.helper.ts', ['io'], 'remove(path)'],
    ['src/files/config/disk.config.ts', ['io'], 'disk.unlink(path)'],
    ['src/files/helpers/wrong.repository.ts', ['io'], 'unlink(path)'],
    ['src/files/repositories/no-export.repository.ts', ['io'], 'unlink('],
    ['src/files/misplaced.repository.ts', ['io', 'placement'], 'unlink(path)'],
    ['src/files/repositories/network.repository.ts', ['io'], 'send(url)'],
    ['src/files/repositories/alias.repository.ts', ['io'], 'send(url)'],
    ['src/files/repositories/process.repository.ts', ['io'], 'execFile('],
    ['src/files/repositories/timer.repository.ts', ['io'], 'wait(1)'],
    [
      'src/files/repositories/http.repository.ts',
      ['io'],
      'response.status(204)',
    ],
  ]) {
    test(`${name}: filesystem exception stays bounded ${file}`, async () => {
      const messages = await lint(file);
      assert.equal(
        messages.length,
        expectedIds.length,
        JSON.stringify(messages),
      );
      assert.ok(
        messages.every(
          (message) => message.ruleId === 'architecture/boundaries',
        ),
        JSON.stringify(messages),
      );
      assert.deepEqual(
        messages.map((message) => message.messageId).sort(),
        [...expectedIds].sort(),
        JSON.stringify(messages),
      );
      assert.ok(
        messages.some(
          (message) =>
            message.messageId === 'io' &&
            sources
              .get(file)
              .split('\n')
              .slice(message.line - 1, message.endLine)
              .join('\n')
              .includes(token),
        ),
        JSON.stringify(messages),
      );
    });
  }
  for (const file of [
    'src/transport/controllers/events.controller.ts',
    'src/composition/renamed.ts',
  ]) {
    test(`${name}: authentic transport or composition ${file}`, async () => {
      assert.deepEqual(await lint(file), []);
    });
  }
  for (const [file, expectedIds] of [
    ['src/transport/controllers/not-sse.controller.ts', ['io']],
    ['src/transport/controllers/spoof.controller.ts', ['io']],
    ['src/transport/controllers/outbound.controller.ts', ['io']],
    ['src/transport/controllers/disguised.controller.ts', ['io']],
    ['src/main.ts', ['effect', 'io']],
    ['src/composition/typed-fake.ts', ['effect', 'io']],
    ['src/composition/query.ts', ['io', 'io']],
    ['src/composition/files.ts', ['io']],
  ]) {
    test(`${name}: composition and transport exceptions stay bounded ${file}`, async () => {
      const messages = await lint(file);
      assert.equal(
        messages.length,
        expectedIds.length,
        JSON.stringify(messages),
      );
      assert.ok(
        messages.every(
          (message) => message.ruleId === 'architecture/boundaries',
        ),
        JSON.stringify(messages),
      );
      assert.deepEqual(
        messages.map((message) => message.messageId).sort(),
        [...expectedIds].sort(),
        JSON.stringify(messages),
      );
    });
  }
  for (const file of ['src/forward/setup.ts', 'src/forward/start.ts']) {
    test(`${name}: authentic direct setup forwarding ${file}`, async () => {
      assert.deepEqual(await lint(file), []);
    });
  }
  for (const [file, expectedIds] of [
    ['src/forward/fake.ts', ['io', 'effect']],
    ['src/forward/fake-middleware.ts', ['io', 'io']],
    ['src/forward/fake-json.ts', ['effect']],
    ['src/forward/fake-callee.ts', ['effect']],
    ['src/forward/unknown.ts', ['io', 'effect', 'effect']],
    ['src/forward/custom.ts', ['io', 'effect']],
    ['src/forward/callback.ts', ['effect']],
    ['src/forward/business.ts', ['io', 'io', 'io', 'io', 'io']],
    ['src/forward/two-edges.ts', ['io', 'effect']],
    ['src/forward/forged-proxy.ts', ['io']],
  ]) {
    test(`${name}: setup forwarding remains bounded ${file}`, async () => {
      const messages = await lint(file);
      assert.equal(
        messages.length,
        expectedIds.length,
        JSON.stringify(messages),
      );
      assert.ok(
        messages.every(
          (message) => message.ruleId === 'architecture/boundaries',
        ),
        JSON.stringify(messages),
      );
      assert.deepEqual(
        messages.map((message) => message.messageId).sort(),
        [...expectedIds].sort(),
        JSON.stringify(messages),
      );
    });
  }
  for (const file of [
    'src/selected/controllers/scalars.controller.ts',
    'src/selected/controllers/arrays.controller.ts',
    'src/selected/controllers/owned.controller.ts',
    'src/selected/pipes/text.pipe.ts',
  ]) {
    test(`${name}: selected scalar and owned container contracts ${file}`, async () => {
      assert.deepEqual(await lint(file), []);
    });
  }
  for (const [file, ids] of [
    ['src/selected/controllers/inline.controller.ts', ['dto']],
    ['src/selected/controllers/record.controller.ts', ['dto']],
    ['src/selected/controllers/service.controller.ts', ['dto']],
    ['src/selected/controllers/namespace.controller.ts', ['dto']],
    ['src/selected/controllers/objects.controller.ts', ['dto']],
    ['src/selected/controllers/nested.controller.ts', ['dto']],
    ['src/selected/controllers/mixed.controller.ts', ['dto']],
    ['src/selected/controllers/metadata.controller.ts', ['metadata']],
    ['src/selected/controllers/unknown.controller.ts', ['boundary']],
    ['src/selected/controllers/any.controller.ts', ['boundary']],
    ['src/selected/controllers/generic.controller.ts', ['boundary']],
    ['src/selected/controllers/empty.controller.ts', ['dto']],
    ['src/selected/controllers/fake-pipe.controller.ts', ['boundary', 'dto']],
    ['src/selected/controllers/pipe-output.controller.ts', ['boundary']],
    ['src/selected/controllers/pipe-factory.controller.ts', ['boundary']],
    ['src/selected/controllers/erased-pipe.controller.ts', ['boundary']],
  ]) {
    test(`${name}: selected binding cannot conceal containers ${file}`, async () => {
      const messages = await lint(file);
      assert.equal(messages.length, ids.length, JSON.stringify(messages));
      assert.ok(
        messages.every(
          (message) => message.ruleId === 'architecture/boundaries',
        ),
        JSON.stringify(messages),
      );
      assert.deepEqual(
        messages.map((message) => message.messageId).sort(),
        [...ids].sort(),
        JSON.stringify(messages),
      );
    });
  }
  for (const file of [
    'src/plain/adapters/default.adapter.ts',
    'src/plain/adapters/optional.adapter.ts',
  ]) {
    test(`${name}: metadata-free default provider ${file}`, async () => {
      assert.deepEqual(await lint(file), []);
    });
  }
  for (const file of [
    'src/plain/services/required.service.ts',
    'src/plain/services/decorated.service.ts',
    'src/plain/services/inherited.service.ts',
    'src/plain/services/static.service.ts',
    'src/plain/services/forged.service.ts',
    'src/plain/services/reflected.service.ts',
  ]) {
    test(`${name}: default metadata exception stays bounded ${file}`, async () => {
      const messages = await lint(file);
      assert.equal(messages.length, 1, JSON.stringify(messages));
      assert.equal(messages[0].ruleId, 'architecture/boundaries');
      assert.equal(messages[0].messageId, 'di');
    });
  }
  for (const file of [
    'src/startup/renamed.ts',
    'src/startup/host-alias.ts',
    'src/startup/pure-lookalike.ts',
  ]) {
    test(`${name}: authenticated startup failure boundary ${file}`, async () => {
      assert.deepEqual(await lint(file), []);
    });
  }
  for (const [file, ids] of [
    ['src/startup/write.ts', ['io']],
    ['src/startup/catch-write.ts', ['io']],
    ['src/startup/spawn.ts', ['io']],
    ['src/startup/network.ts', ['io']],
    ['src/startup/query.ts', ['io']],
    ['src/startup/typed-console.ts', ['effect']],
    ['src/startup/typed-host-object.ts', ['effect']],
    ['src/startup/typed-process.ts', ['effect']],
    ['src/startup/exit-zero.ts', ['effect']],
    ['src/startup/nested-callback.ts', ['effect', 'effect']],
    ['src/startup/shadow.ts', ['effect']],
    ['src/startup/fake-promise.ts', ['effect', 'effect']],
    ['src/startup/fake-callee.ts', ['effect', 'effect', 'effect']],
    ['src/startup/unrelated.ts', ['effect', 'effect']],
    ['src/startup/no-listen.ts', ['effect', 'effect', 'effect']],
  ]) {
    test(`${name}: startup authority does not escape ${file}`, async () => {
      const messages = await lint(file);
      assert.equal(messages.length, ids.length, JSON.stringify(messages));
      assert.ok(
        messages.every(
          (message) => message.ruleId === 'architecture/boundaries',
        ),
        JSON.stringify(messages),
      );
      assert.deepEqual(
        messages.map((message) => message.messageId).sort(),
        [...ids].sort(),
        JSON.stringify(messages),
      );
    });
  }
  for (const file of [
    'src/clock/ports/clock.port.ts',
    'src/clock/adapters/system-clock.adapter.ts',
    'src/clock/clock.module.ts',
    'src/clock/async.module.ts',
    'src/clock/namespace.module.ts',
    'src/clock/ports/named.port.ts',
    'src/clock/named-barrel.ts',
    'src/clock/named.module.ts',
  ]) {
    test(`${name}: abstract provider token owns a port ${file}`, async () => {
      assert.deepEqual(await lint(file), []);
    });
  }
  for (const [file, ids] of [
    ['src/clock/ports/unused.port.ts', ['placement']],
    ['src/clock/ports/fake.port.ts', ['placement']],
    ['src/clock/ports/concrete.port.ts', ['placement']],
    ['src/clock/ports/stateful.port.ts', ['role', 'io']],
    ['src/clock/ports/forged.port.ts', ['placement']],
    ['src/clock/forged.module.ts', ['module']],
    ['src/clock/erased.module.ts', ['module']],
    ['src/clock/wrong-async.module.ts', ['module']],
    ['src/clock/erased-namespace.module.ts', ['module']],
    ['src/clock/misplaced.ts', ['placement']],
    ['src/clock/ports/unregistered-named.port.ts', ['placement']],
    ['src/clock/erased-barrel.module.ts', ['module']],
  ]) {
    test(`${name}: port authority requires a real abstract binding ${file}`, async () => {
      const messages = await lint(file);
      assert.equal(messages.length, ids.length, JSON.stringify(messages));
      assert.ok(
        messages.every(
          (message) => message.ruleId === 'architecture/boundaries',
        ),
        JSON.stringify(messages),
      );
      assert.deepEqual(
        messages.map((message) => message.messageId).sort(),
        [...ids].sort(),
        JSON.stringify(messages),
      );
    });
  }
  test(`${name}: native inbound response header identity survives aliases and private forwarding`, async () => {
    assert.deepEqual(
      await lint('src/headers/controllers/inbound.controller.ts'),
      [],
    );
  });
  test(`${name}: inbound and ordinary Writable streams are not outbound clients`, async () => {
    assert.deepEqual(
      await lint('src/headers/controllers/streams.controller.ts'),
      [],
    );
  });
  test(`${name}: a generic stream without a resolved client constituent stays inbound`, async () => {
    assert.deepEqual(
      await lint('src/headers/controllers/generic-stream.controller.ts'),
      [],
    );
  });
  test(`${name}: a receiver constrained to an ordinary Writable stays inbound`, async () => {
    assert.deepEqual(
      await lint('src/headers/controllers/constrained-stream.controller.ts'),
      [],
    );
  });
  for (const [file, effect] of [
    ['src/headers/controllers/client.controller.ts', 'network'],
    ['src/headers/controllers/lookalike.controller.ts', 'network'],
    ['src/headers/controllers/mixed.controller.ts', 'network'],
    ['src/headers/helpers/headers.helper.ts', 'HTTP transport'],
    ['src/headers/controllers/write.controller.ts', 'network'],
    ['src/headers/controllers/end.controller.ts', 'network'],
    ['src/headers/controllers/mixed-write.controller.ts', 'network'],
    ['src/headers/controllers/generic.controller.ts', 'network'],
    ['src/headers/controllers/generic-write.controller.ts', 'network'],
    ['src/headers/controllers/generic-end.controller.ts', 'network'],
    ['src/headers/controllers/inherited-write.controller.ts', 'network'],
    ['src/headers/controllers/constrained-write.controller.ts', 'network'],
    ['src/headers/controllers/constrained-end.controller.ts', 'network'],
  ]) {
    test(`${name}: response header capability stays inbound ${file}`, async () => {
      const messages = await lint(file);
      assert.equal(messages.length, 1, JSON.stringify(messages));
      assert.equal(messages[0].ruleId, 'architecture/boundaries');
      assert.equal(messages[0].messageId, 'io');
      assert.ok(messages[0].message.includes(effect), JSON.stringify(messages));
    });
  }
  for (const file of [
    'src/aux/guards/cookie.guard.ts',
    'src/aux/filters/response.filter.ts',
  ]) {
    test(`${name}: genuine auxiliary HTTP duties ${file}`, async () => {
      assert.deepEqual(await lint(file), []);
    });
  }
  for (const [file, id] of [
    ['src/aux/guards/client.guard.ts', 'io'],
    ['src/aux/filters/client.filter.ts', 'io'],
    ['src/aux/guards/network.guard.ts', 'io'],
    ['src/aux/filters/network.filter.ts', 'io'],
    ['src/aux/guards/disk.guard.ts', 'io'],
    ['src/aux/filters/disk.filter.ts', 'io'],
    ['src/aux/guards/query.guard.ts', 'io'],
    ['src/aux/filters/query.filter.ts', 'io'],
    ['src/aux/guards/functional-query.guard.ts', 'io'],
    ['src/aux/filters/functional-query.filter.ts', 'io'],
    ['src/aux/guards/overload-query.guard.ts', 'io'],
    ['src/aux/filters/annotated-query.filter.ts', 'io'],
    ['src/aux/helpers/misplaced.helper.ts', 'placement'],
    ['src/aux/helpers/header.helper.ts', 'io'],
  ]) {
    test(`${name}: auxiliary HTTP authority does not grant business I/O ${file}`, async () => {
      const messages = await lint(file);
      assert.equal(messages.length, 1, JSON.stringify(messages));
      assert.equal(messages[0].ruleId, 'architecture/boundaries');
      assert.equal(messages[0].messageId, id);
    });
  }
  for (const file of [
    'src/manual/services/session.service.ts',
    'src/manual/services/producer.service.ts',
  ]) {
    test(`${name}: one-edge manual service ownership ${file}`, async () => {
      assert.deepEqual(await lint(file), []);
    });
  }
  for (const [file, id] of [
    ['src/manual/services/unowned.service.ts', 'placement'],
    ['src/manual/services/fake-target.service.ts', 'placement'],
    ['src/manual/services/erased.service.ts', 'placement'],
    ['src/manual/services/wrapped.service.ts', 'placement'],
    ['src/manual/services/different.service.ts', 'placement'],
    ['src/manual/services/domain.service.ts', 'placement'],
    ['src/manual/services/path-only.service.ts', 'placement'],
    ['src/manual/services/name.service.ts', 'placement'],
    ['src/manual/services/chained.service.ts', 'placement'],
    ['src/manual/services/automatic.service.ts', 'di'],
    ['src/manual/services/registered.service.ts', 'di'],
  ]) {
    test(`${name}: manual construction proof cannot be fabricated ${file}`, async () => {
      const messages = await lint(file);
      assert.equal(messages.length, 1, JSON.stringify(messages));
      assert.equal(messages[0].ruleId, 'architecture/boundaries');
      assert.equal(messages[0].messageId, id);
    });
  }
  for (const file of [
    'src/pathproof/config/storage.config.ts',
    'src/pathproof/helpers/paths.helper.ts',
    'src/pathproof/config/cwd.config.ts',
  ]) {
    test(`${name}: actual Node path and cwd configuration reads ${file}`, async () => {
      assert.deepEqual(await lint(file), []);
    });
  }
  for (const [file, ids] of [
    ['src/pathproof/helpers/lookalike.helper.ts', ['effect']],
    ['src/pathproof/helpers/opaque.helper.ts', ['effect']],
    ['src/pathproof/helpers/typed-path.helper.ts', ['effect']],
    ['src/pathproof/helpers/typed-platform.helper.ts', ['effect']],
    ['src/pathproof/helpers/typed-process.helper.ts', ['effect']],
    ['src/pathproof/helpers/shadow.helper.ts', ['effect']],
    ['src/pathproof/helpers/alias.helper.ts', ['effect']],
    ['src/pathproof/config/chdir.config.ts', ['effect']],
    ['src/pathproof/config/exit.config.ts', ['effect']],
    ['src/pathproof/config/kill.config.ts', ['effect']],
    ['src/pathproof/helpers/unsupported.helper.ts', ['effect']],
    ['src/pathproof/config/exists.config.ts', ['io']],
    ['src/pathproof/config/write.config.ts', ['io']],
    ['src/pathproof/config/escape.config.ts', ['effect', 'io']],
    ['src/pathproof/config/network.config.ts', ['io']],
  ]) {
    test(`${name}: native computational reads do not waive effects ${file}`, async () => {
      const messages = await lint(file);
      assert.equal(messages.length, ids.length, JSON.stringify(messages));
      assert.ok(
        messages.every(
          (message) => message.ruleId === 'architecture/boundaries',
        ),
        JSON.stringify(messages),
      );
      assert.deepEqual(
        messages.map((message) => message.messageId).sort(),
        [...ids].sort(),
        JSON.stringify(messages),
      );
    });
  }
  for (const file of [
    'src/context/services/context.service.ts',
    'src/common/services/tenant-context.service.ts',
    'src/context/services/consumer.service.ts',
    'src/scope/interceptors/scope.interceptor.ts',
    'src/metadata/decorators/skip.decorator.ts',
    'src/metadata/decorators/namespace.decorator.ts',
    'src/metadata/controllers/authentic.controller.ts',
  ]) {
    test(`${name}: bounded context and framework ownership ${file}`, async () => {
      assert.deepEqual(await lint(file), []);
    });
  }
  for (const [file, ids] of [
    ['src/context/helpers/misplaced.helper.ts', ['effect', 'effect', 'effect']],
    ['src/context/adapters/context.adapter.ts', ['effect', 'effect', 'effect']],
    [
      'src/context/services/bad-consumer.service.ts',
      ['dependency', 'dependency'],
    ],
    ['src/context/services/forged.service.ts', ['effect', 'effect', 'effect']],
    ['src/context/services/typed.service.ts', ['effect', 'effect']],
    [
      'src/context/services/unexported.service.ts',
      ['effect', 'effect', 'effect'],
    ],
    ['src/context/services/spread.service.ts', ['effect', 'effect']],
    ['src/context/services/computed.service.ts', ['effect', 'effect']],
    ['src/context/services/accessor.service.ts', ['effect', 'effect']],
    ['src/context/services/data.service.ts', ['effect']],
    ['src/context/services/opaque.service.ts', ['effect']],
    ['src/context/services/fs.service.ts', ['io']],
    ['src/context/services/network.service.ts', ['io']],
    ['src/context/services/disable.service.ts', ['effect']],
    ['src/scope/interceptors/fake.interceptor.ts', ['io']],
    ['src/scope/interceptors/forged.interceptor.ts', ['io']],
    ['src/scope/interceptors/wrapped.interceptor.ts', ['io']],
    ['src/scope/guards/scope.guard.ts', ['io']],
    [
      'src/scope/controllers/scope.controller.ts',
      ['dependency', 'dependency', 'dependency', 'io'],
    ],
    ['src/scope/interceptors/query.interceptor.ts', ['io']],
    ['src/scope/interceptors/connect.interceptor.ts', ['io']],
    ['src/scope/interceptors/raw.interceptor.ts', ['io']],
    ['src/scope/interceptors/fs.interceptor.ts', ['io']],
    ['src/scope/interceptors/network.interceptor.ts', ['io']],
    ['src/metadata/helpers/misplaced.helper.ts', ['effect']],
    ['src/metadata/decorators/forged.decorator.ts', ['effect']],
    ['src/metadata/decorators/namespace-forged.decorator.ts', ['effect']],
    ['src/metadata/decorators/erased.decorator.ts', ['effect']],
    ['src/metadata/decorators/local.decorator.ts', ['effect']],
    ['src/metadata/decorators/fs.decorator.ts', ['effect', 'io']],
    ['src/metadata/decorators/network.decorator.ts', ['effect', 'io']],
    ['src/metadata/decorators/db.decorator.ts', ['effect', 'io', 'io']],
    ['src/metadata/controllers/fixture.controller.ts', ['io']],
    ['src/metadata/guards/fixture.guard.ts', ['io']],
  ]) {
    test(`${name}: context and metadata authority stays bounded ${file}`, async () => {
      const messages = await lint(file);
      assert.equal(messages.length, ids.length, JSON.stringify(messages));
      assert.ok(
        messages.every(
          (message) => message.ruleId === 'architecture/boundaries',
        ),
        JSON.stringify(messages),
      );
      assert.deepEqual(
        messages.map((message) => message.messageId).sort(),
        [...ids].sort(),
        JSON.stringify(messages),
      );
    });
  }
  for (const [file, id, token] of [
    ['src/review/helpers/spoof.helper.ts', 'effect', 'config.get<'],
    ['src/review/helpers/spoof.helper.ts', 'effect', 'config.getOrThrow<'],
    ['src/review/controllers/network.controller.ts', 'io', 'request(url)'],
    ['src/pure/helpers/database.helper.ts', 'io', 'findMany'],
    ['src/pure/renamed.ts', 'io', 'Client'],
    ['src/pure/config/database.config.ts', 'io', 'PrismaClient'],
    ['src/pure/helpers/network.helper.ts', 'io', 'send'],
    ['src/pure/helpers/namespace.helper.ts', 'io', 'readFile'],
    ['src/pure/helpers/process.helper.ts', 'io', 'execute'],
    ['src/pure/helpers/timer.helper.ts', 'io', 'setTimeout'],
    ['src/pure/helpers/fetch.helper.ts', 'io', 'fetch'],
    ['src/pure/helpers/opaque.helper.ts', 'effect', 'callback'],
    ['src/pure/wrong-reader.ts', 'placement', 'Reader'],
    ['src/pure/wrong-error.ts', 'placement', 'DomainFailure'],
    ['src/pure/helpers/registered.helper.ts', 'role', 'Reader'],
    [
      'src/pure/repositories/local-http.repository.ts',
      'dependency',
      'LocalDenied',
    ],
    ['src/aux/guards/overload-query.guard.ts', 'io', 'readPage(db, 1)'],
    ['src/aux/filters/annotated-query.filter.ts', 'io', 'listRows(db)'],
    ['src/factory/callable-value.module.ts', 'module', 'useValue'],
    ['src/factory/opaque.module.ts', 'module', 'useFactory'],
    ['src/factory/erased.module.ts', 'module', 'useFactory'],
    ['src/factory/spread.module.ts', 'module', 'binding'],
    ['src/factory/computed.module.ts', 'module', 'key'],
    ['src/factory/nonclass.module.ts', 'module', '42'],
    ['src/factory/fake.module.ts', 'role', 'FakeModule'],
    ['src/factory/services/dual.service.ts', 'di', 'options'],
    ['src/demo/controllers/query.controller.ts', 'dependency', 'findMany'],
    ['src/demo/controllers/client.controller.ts', 'dependency', 'PrismaClient'],
    [
      'src/demo/repositories/noninfra-member.repository.ts',
      'dependency',
      'service.read',
    ],
    [
      'src/demo/repositories/samefile-member.repository.ts',
      'dependency',
      'service.read',
    ],
    ['src/demo/controllers/wrong-name.controller.ts', 'placement', 'WrongName'],
    ['src/demo/services/wrong-name.service.ts', 'placement', 'WrongName'],
    [
      'src/demo/repositories/wrong-name.repository.ts',
      'placement',
      'WrongName',
    ],
    [
      'src/demo/controllers/lowercase.controller.ts',
      'placement',
      'lowercaseController',
    ],
    ['src/demo/wrong-name.module.ts', 'placement', 'Wrong'],
    ['src/demo/wrong-file.ts', 'placement', 'WrongFileModule'],
    ['src/demo/helpers/hidden.module.ts', 'placement', 'HiddenModule'],
    ['src/demo/services/hidden.module.ts', 'placement', 'HiddenModule'],
    ['src/demo/dto/hidden.module.ts', 'placement', 'HiddenModule'],
    ['src/helpers/hidden.module.ts', 'placement', 'HiddenModule'],
    ['src/other.module.ts', 'placement', 'OtherModule'],
    ['src/demo/repositories/warehouse.ts', 'placement', 'Warehouse'],
    ['src/demo/controllers/warehouse.controller.ts', 'dependency', 'Warehouse'],
    ['src/demo/controllers/counterfeit.controller.ts', 'dto', 'body'],
    ['src/demo/services/controller.service.ts', 'dependency', 'GoodController'],
    ['src/demo/services/controller-alias.service.ts', 'dependency', 'Hidden'],
    ['src/demo/dto/service-request.dto.ts', 'dependency', 'Hidden'],
    ['src/demo/dto/repository-request.dto.ts', 'dependency', 'GoodRepository'],
    ['src/demo/dto/interface-request.dto.ts', 'dependency', 'GoodController'],
    ['src/demo/dto/reexport-request.dto.ts', 'dependency', 'GoodService'],
    ['src/demo/dto/barrel-request.dto.ts', 'dependency', 'Hidden'],
    ['src/demo/dto/prisma-request.dto.ts', 'dependency', 'PrismaClient'],
    ['src/demo/dto/infra-request.dto.ts', 'dependency', 'PrismaService'],
    ['src/demo/dto/provider-request.dto.ts', 'role', 'ProviderRequestDto'],
    ['src/demo/dto/legacy.dto.ts', 'dtoPlacement', 'LegacyRequestDto'],
    ['src/demo/controllers/legacy.controller.ts', 'dto', 'body'],
    ['src/demo/controllers/wrong-role.controller.ts', 'dto', 'body'],
    [
      'src/demo/controllers/prisma.controller.ts',
      'dependency',
      'PrismaService',
    ],
    [
      'src/demo/repositories/hidden.repository.ts',
      'dependency',
      'BusinessService',
    ],
    ['src/demo/services/erased.service.ts', 'di', 'other'],
    ['src/demo/controllers/type-barrel.controller.ts', 'metadata', 'body'],
    ['src/demo/controllers/namespace-type.controller.ts', 'metadata', 'body'],
    ['src/demo/controllers/computed.controller.ts', 'boundary', 'Param'],
    ['src/demo/controllers/repository.controller.ts', 'dependency', 'Hidden'],
    ['src/demo/controllers/barrel.controller.ts', 'dependency', 'Hidden'],
    ['src/demo/controllers/type.controller.ts', 'dependency', 'GoodRepository'],
    [
      'src/demo/controllers/namespace-dependency.controller.ts',
      'dependency',
      'GoodRepository',
    ],
    ['src/demo/repositories/http.repository.ts', 'dependency', 'Denied'],
    [
      'src/demo/repositories/namespace-http.repository.ts',
      'dependency',
      'ConflictException',
    ],
    ['src/demo/services/adapter.service.ts', 'dependency', 'GoodAdapter'],
    ['src/demo/controllers/unsafe.controller.ts', 'dto', 'body'],
    ['src/demo/controllers/anonymous.controller.ts', 'dto', 'query'],
    ['src/demo/controllers/metadata.controller.ts', 'metadata', 'body'],
    ['src/demo/controllers/erased.controller.ts', 'dto', 'body'],
    ['src/demo/renamed.ts', 'placement', 'Hidden'],
    ['src/demo/renamed.ts', 'dto', 'body'],
    ['src/demo/unknown.ts', 'role', 'Opaque'],
    ['src/demo/renamed.spec.ts', 'placement', 'HiddenController'],
    [
      'src/demo/controllers/computed-import.controller.ts',
      'unresolved',
      'storage',
    ],
    ['src/demo/controllers/dynamic.controller.ts', 'unresolved', 'import('],
    ['src/demo/controllers/require.controller.ts', 'unresolved', 'storage'],
    ['src/demo/dynamic.module.ts', 'module', 'providers'],
    ['src/demo/controllers/renamed.controller.mts', 'dto', 'body'],
  ]) {
    test(`${name}: ${id} at ${file}`, async () => {
      const messages = await lint(file);
      const expected = messages.filter(
        (message) =>
          message.ruleId === 'architecture/boundaries' &&
          message.messageId === id,
      );
      assert.ok(expected.length > 0, JSON.stringify(messages));
      assert.ok(
        expected.some((message) =>
          sources
            .get(file)
            .split('\n')
            .slice(message.line - 1, message.endLine)
            .join('\n')
            .includes(token),
        ),
        JSON.stringify(expected),
      );
    });
  }
  test(`${name}: file outside compiler project fails closed`, async () => {
    const file = 'src/outside.js';
    await writeFile(path.join(root, file), 'export const value = 1;\n');
    const isolated = new ESLint({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: [
        ...config,
        {
          files: ['src/**/*.js'],
          languageOptions: { parserOptions: { tsconfigRootDir: root } },
        },
      ],
    });
    const [result] = await isolated.lintFiles([path.join(root, file)]);
    assert.ok(
      result.messages.some(
        (message) => message.fatal && /project|tsconfig/i.test(message.message),
      ),
      JSON.stringify(result.messages),
    );
  });
}
