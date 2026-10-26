import { createHash } from 'node:crypto';
import Fastify, { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { createMemberQr, readMemberQr } from './qr.js';
import { DomainError, type DatabasePort, type Identity, type Mutation, type StaffRole, type TokenVerifier } from './types.js';

export interface AppOptions {
  db: DatabasePort;
  verifier: TokenVerifier;
  qrSecret: string;
  demoMode?: boolean;
  demoHtml?: string;
  now?: () => Date;
  allowedOrigins?: string[];
  logger?: boolean;
}

type Params = { storeId: string; memberId?: string; couponId?: string; id?: string; uid?: string };
const text = (maxLength: number, minLength = 1) => ({ type: 'string', minLength, maxLength });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const emptyBody = object({});
const noticeBody = object({ title: text(80), body: text(1000) });
const storeParams = { storeId: { ...text(64), pattern: '^[A-Za-z0-9_-]+$' } };
const paramsSchema = (extra: Record<string, unknown> = {}) => object({ ...storeParams, ...extra });
const base = '/api/stores/:storeId';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

export async function createApp(options: AppOptions) {
  if (options.qrSecret.length < 32) throw new Error('QR signing secret must contain at least 32 characters');
  const { db, verifier } = options;
  const now = options.now ?? (() => new Date());
  const app = Fastify({
    bodyLimit: 32 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] } : false,
  });

  if (options.demoMode) {
    // A loopback listener alone does not stop browser DNS-rebinding to public demo identities.
    app.addHook('onRequest', async (request, reply) => {
      try {
        const host = request.headers.host;
        if (typeof host !== 'string') throw new Error('Missing Host');
        const local = new URL(`http://${host}`);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname)
          || local.username || local.password || local.pathname !== '/') throw new Error('Non-local Host');
        const origin = request.headers.origin;
        if (origin !== undefined && (typeof origin !== 'string' || new URL(origin).origin !== local.origin)) {
          throw new Error('Cross-origin demo access');
        }
      } catch {
        return reply.code(403).send({ error: { code: 'LOCAL_DEMO_ONLY', message: '試用画面は、このPCの同じアドレスから開いてください。' } });
      }
    });
  }

  await app.register(cors, { origin: options.allowedOrigins ?? [], credentials: false });
  await app.register(rateLimit, {
    max: 120, timeWindow: '1 minute',
    errorResponseBuilder: () => ({ error: { code: 'RATE_LIMITED', message: '操作が続いています。少し待ってからお試しください。' } }),
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return payload;
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    const failure = error && typeof error === 'object'
      ? error as { validation?: unknown; statusCode?: number; name?: string } : {};
    if (failure.validation || failure.statusCode === 400 || failure.statusCode === 413 || failure.statusCode === 415) {
      return reply.code(failure.statusCode === 413 ? 413 : 400).send({ error: { code: 'INVALID_REQUEST', message: '入力内容を確認してください。' } });
    }
    if (failure.statusCode === 429) {
      return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: '操作が続いています。少し待ってからお試しください。' } });
    }
    app.log.error({ event: 'request_failure', requestId: request.id, errorType: failure.name ?? 'UnknownError' }, '管理APIの処理に失敗しました。');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '処理を完了できませんでした。時間をおいて再試行してください。' } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: '指定された操作が見つかりません。' } }));

  const params = (request: FastifyRequest) => request.params as Params;
  async function identity(request: FastifyRequest): Promise<Identity> {
    const store = db.getStore(params(request).storeId);
    const authorization = request.headers.authorization;
    const match = typeof authorization === 'string' && authorization.length <= 8192
      ? /^Bearer ([^\s]+)$/i.exec(authorization) : null;
    if (!match) throw new DomainError('UNAUTHENTICATED', 401, 'ログインしてください。');
    let actor: Identity;
    try { actor = await verifier.verify(match[1], store.firebaseProjectId); }
    catch { throw new DomainError('UNAUTHENTICATED', 401, 'ログインを確認できません。もう一度ログインしてください。'); }
    if (actor.projectId !== store.firebaseProjectId || !actor.uid || actor.uid.length > 128) {
      throw new DomainError('UNAUTHENTICATED', 401, 'この店舗のログインを確認できません。');
    }
    return actor;
  }
  async function staff(request: FastifyRequest, ownerOnly = false): Promise<Identity> {
    const actor = await identity(request);
    const account = db.getStaff(params(request).storeId, actor);
    if (!account?.active || (ownerOnly && account.role !== 'owner')) {
      throw new DomainError('FORBIDDEN', 403, ownerOnly ? '店舗管理者の権限が必要です。' : 'この店舗のスタッフ権限が必要です。');
    }
    return actor;
  }
  function mutation(request: FastifyRequest, actor: Identity): Mutation {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 400, '操作を識別するIdempotency-Keyを指定してください。');
    }
    const fingerprint = createHash('sha256').update(JSON.stringify([
      request.method, request.routeOptions.url, stable(request.params), stable(request.body ?? {}),
    ])).digest('hex');
    return { actor, idempotencyKey: key, fingerprint };
  }

  app.get('/health', async () => ({ status: 'ok', authMode: options.demoMode ? 'demo' : 'firebase' }));
  const landing = async (_request: FastifyRequest, reply: FastifyReply) => {
    if (options.demoMode && options.demoHtml) return reply.type('text/html; charset=utf-8').send(options.demoHtml);
    return { service: 'むさしの玉屋 管理API', health: '/health', authMode: 'firebase' };
  };
  app.get('/', landing);
  if (options.demoMode && options.demoHtml) app.get('/demo', landing);

  app.get(base, { schema: { params: paramsSchema() } }, async (request) => db.getStore(params(request).storeId));
  app.get(`${base}/notices`, { schema: { params: paramsSchema() } }, async (request) => db.listNotices(params(request).storeId));
  app.post(`${base}/memberships`, { schema: { params: paramsSchema(), body: object({ nickname: text(20) }) } }, async (request) => {
    const actor = await identity(request);
    return db.registerMember(params(request).storeId, actor, (request.body as { nickname: string }).nickname);
  });
  app.get(`${base}/me`, { schema: { params: paramsSchema() } }, async (request) => db.getOwnMember(params(request).storeId, await identity(request)));
  app.get(`${base}/me/role`, { schema: { params: paramsSchema() } }, async (request) => db.getStaff(params(request).storeId, await identity(request)));
  app.get(`${base}/me/qr`, { schema: { params: paramsSchema() } }, async (request) => {
    const member = db.getOwnMember(params(request).storeId, await identity(request));
    return createMemberQr({ storeId: member.storeId, memberId: member.id }, options.qrSecret, now());
  });
  app.post(`${base}/staff/resolve-qr`, { schema: { params: paramsSchema(), body: object({ qr: text(2048) }) } }, async (request) => {
    await staff(request);
    const { storeId, memberId } = readMemberQr((request.body as { qr: string }).qr, params(request).storeId, options.qrSecret, now());
    return db.getMember(storeId, memberId);
  });
  app.get(`${base}/staff/members`, {
    schema: { params: paramsSchema(), querystring: object({ query: text(80, 0) }, []) },
  }, async (request) => {
    await staff(request);
    return db.listMembers(params(request).storeId, (request.query as { query?: string }).query);
  });
  app.get(`${base}/staff/members/:memberId`, { schema: { params: paramsSchema({ memberId: text(128) }) } }, async (request) => {
    await staff(request);
    return db.getMember(params(request).storeId, params(request).memberId!);
  });
  app.post(`${base}/staff/members/:memberId/stamps`, {
    schema: { params: paramsSchema({ memberId: text(128) }), body: emptyBody },
  }, async (request) => {
    const actor = await staff(request);
    return db.grantStamp(params(request).storeId, params(request).memberId!, mutation(request, actor));
  });
  app.post(`${base}/staff/coupons/:couponId/redeem`, {
    schema: { params: paramsSchema({ couponId: text(128) }), body: emptyBody },
  }, async (request) => {
    const actor = await staff(request);
    return db.redeemCoupon(params(request).storeId, params(request).couponId!, mutation(request, actor));
  });
  app.get(`${base}/staff/stats`, { schema: { params: paramsSchema() } }, async (request) => {
    await staff(request);
    return db.stats(params(request).storeId);
  });
  app.post(`${base}/staff/notices`, { schema: { params: paramsSchema(), body: noticeBody } }, async (request) => {
    const actor = await staff(request);
    return db.saveNotice(params(request).storeId, request.body as { title: string; body: string }, mutation(request, actor));
  });
  app.put(`${base}/staff/notices/:id`, { schema: { params: paramsSchema({ id: text(128) }), body: noticeBody } }, async (request) => {
    const actor = await staff(request);
    return db.saveNotice(params(request).storeId, { ...(request.body as { title: string; body: string }), id: params(request).id! }, mutation(request, actor));
  });
  app.get(`${base}/staff/audit`, { schema: { params: paramsSchema() } }, async (request) => {
    const actor = await staff(request, true);
    return db.audit(params(request).storeId, actor);
  });
  app.get(`${base}/staff/accounts`, { schema: { params: paramsSchema() } }, async (request) => {
    const actor = await staff(request, true);
    return db.listStaff(params(request).storeId, actor);
  });
  app.put(`${base}/staff/accounts/:uid`, {
    schema: {
      params: paramsSchema({ uid: text(128) }),
      body: object({ role: { type: 'string', enum: ['owner', 'staff'] }, active: { type: 'boolean' } }),
    },
  }, async (request) => {
    const actor = await staff(request, true);
    const input = request.body as { role: StaffRole; active: boolean };
    return db.setStaff(params(request).storeId, params(request).uid!, input.role, input.active, mutation(request, actor));
  });
  return app;
}
