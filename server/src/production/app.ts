import { createHash } from 'node:crypto';
import Fastify, { LogController, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { DomainError } from '../types.js';
import { createMemberQr, readMemberQr } from '../qr.js';
import type { StaffRole } from '../../../shared/contracts.js';
import type {
  ProductionDatabasePort, ProductionIdentity, ProductionMutation, ProductionVerifier,
} from './types.js';

export interface ProductionAppOptions {
  db: ProductionDatabasePort; verifier: ProductionVerifier; projectId: string;
  storeId: string; qrSecret: string; allowedOrigins?: string[]; localOnly?: boolean;
  authMode?: 'firebase' | 'emulator'; now?: () => Date; logger?: boolean; trustProxyHops?: number;
}
const base = '/v1/stores/:storeId';
type Params = { storeId: string; memberId?: string; couponId?: string; id?: string; uid?: string };
const text = (maxLength: number, minLength = 1) => ({ type: 'string', minLength, maxLength });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const paramsSchema = (extra: Record<string, unknown> = {}) => object({
  storeId: { ...text(64), pattern: '^[A-Za-z0-9_-]+$' }, ...extra,
});
const noticeBody = object({ title: text(80), body: text(1000) });
const purchaseBody = object({ purchaseAmountYen: { type: 'integer', minimum: 0, maximum: 100_000_000 } });
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}
function page(title: string, body: string, operator: string): string {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{margin:0;background:#f5f2e9;color:#292f2b;font:18px/1.85 system-ui,sans-serif}main{max-width:760px;margin:auto;padding:32px 24px}h1{font-size:28px;line-height:1.5}p{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#234c3a}</style><main><h1>${escape(title)}</h1><p>${escape(body)}</p><p>${escape(operator)}</p><p><a href="/privacy">プライバシーポリシー</a>　<a href="/terms">利用規約</a>　<a href="/support">お問い合わせ</a></p></main></html>`;
}

/** Also called on startup/interval so interrupted deletion resumes without a valid client token. */
export async function processDeletionJobs(
  db: ProductionDatabasePort, verifier: ProductionVerifier, expectedProjectId: string,
): Promise<{ completed: number; failed: number }> {
  const jobs = await db.pendingDeletions(expectedProjectId);
  let completed = 0, failed = 0;
  for (const job of jobs) {
    if (job.projectId !== expectedProjectId) { failed += 1; continue; }
    try { await verifier.deleteUser(job.uid); await db.completeDeletion(job.id); completed += 1; }
    catch { failed += 1; }
  }
  return { completed, failed };
}

export async function createProductionApp(options: ProductionAppOptions) {
  if (options.qrSecret.length < 32) throw new Error('QR署名用の秘密値を設定してください。');
  if (!Number.isInteger(options.trustProxyHops ?? 0) || (options.trustProxyHops ?? 0) < 0 || (options.trustProxyHops ?? 0) > 3) throw new Error('中継サーバー数の設定を確認してください。');
  const { db, verifier } = options;
  const now = options.now ?? (() => new Date());
  const app = Fastify({
    bodyLimit: 32 * 1024,
    trustProxy: options.trustProxyHops ? (_address: string, hop: number) => hop < options.trustProxyHops! : false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] } : false,
  });
  if (options.localOnly) app.addHook('onRequest', async (request, reply) => {
    try {
      const raw = request.headers.host;
      if (!raw) throw new Error('Missing Host');
      const host = new URL(`http://${raw}`);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname) || host.pathname !== '/' || host.username || host.password) throw new Error('Nonlocal Host');
      const origin = request.headers.origin;
      if (origin && origin !== host.origin && !options.allowedOrigins?.includes(origin)) throw new Error('Untrusted origin');
    } catch {
      return reply.code(403).send({ error: { code: 'LOCAL_TEST_ONLY', message: 'ローカル検証サーバーには、このPCの許可した接続元からアクセスしてください。' } });
    }
  });
  await app.register(cors, {
    origin: options.allowedOrigins ?? [], credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'], maxAge: 600,
  });
  await app.register(rateLimit, {
    // Store Wi-Fi/NAT can legitimately put several authenticated devices behind one IP.
    max: 600, timeWindow: '1 minute',
    errorResponseBuilder: () => ({ statusCode: 429, error: { code: 'RATE_LIMITED', message: '操作が続いています。少し待ってからお試しください。' } }),
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    return payload;
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    const failure = error as { validation?: unknown; statusCode?: number; name?: string };
    if (failure.validation || [400, 413, 415].includes(failure.statusCode ?? 0)) return reply.code(failure.statusCode === 413 ? 413 : 400)
      .send({ error: { code: 'INVALID_REQUEST', message: '入力内容を確認してください。' } });
    if (failure.statusCode === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: '操作が続いています。少し待ってからお試しください。' } });
    app.log.error({ event: 'production_request_failure', requestId: request.id, errorType: failure.name ?? 'UnknownError' }, '管理APIの処理に失敗しました。');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '処理を完了できませんでした。時間をおいて再試行してください。' } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: '指定された操作が見つかりません。' } }));
  const params = (request: FastifyRequest) => request.params as Params;
  async function identity(request: FastifyRequest, allowUnverified = false): Promise<ProductionIdentity> {
    const storeId = params(request).storeId;
    if (storeId !== options.storeId) throw new DomainError('STORE_NOT_FOUND', 404, 'この店舗は利用できません。');
    const authorization = request.headers.authorization;
    const match = typeof authorization === 'string' && authorization.length <= 8192 ? /^Bearer ([^\s]+)$/i.exec(authorization) : null;
    if (!match) throw new DomainError('UNAUTHENTICATED', 401, 'ログインしてください。');
    let actor: ProductionIdentity;
    try { actor = await verifier.verify(match[1], { allowUnverified }); }
    catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('UNAUTHENTICATED', 401, 'ログインを確認できません。もう一度ログインしてください。');
    }
    if (!actor.uid || actor.uid.length > 128 || actor.projectId !== options.projectId) throw new DomainError('UNAUTHENTICATED', 401, 'この店舗のログインを確認できません。');
    if (!actor.emailVerified && !allowUnverified) throw new DomainError('EMAIL_NOT_VERIFIED', 403, 'メールアドレスの確認を完了してください。');
    return actor;
  }
  async function staff(request: FastifyRequest, ownerOnly = false): Promise<ProductionIdentity> {
    const actor = await identity(request);
    const account = await db.getStaff(params(request).storeId, actor);
    if (!account?.active || (ownerOnly && account.role !== 'owner')) throw new DomainError('FORBIDDEN', 403, ownerOnly ? '店舗管理者の権限が必要です。' : 'スタッフ権限がありません。');
    return actor;
  }
  function mutation(request: FastifyRequest, actor: ProductionIdentity): ProductionMutation {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 400, '操作を識別するIdempotency-Keyが必要です。');
    return { actor, idempotencyKey: key, fingerprint: createHash('sha256').update(JSON.stringify([
      request.method, request.routeOptions.url, stable(request.params), stable(request.body ?? {}),
    ])).digest('hex') };
  }
  function configuredStore(request: FastifyRequest): string {
    const storeId = params(request).storeId;
    if (storeId !== options.storeId) throw new DomainError('STORE_NOT_FOUND', 404, 'この店舗は利用できません。');
    return storeId;
  }
  app.get('/health', async (_request, reply) => {
    try { await db.getStore(options.storeId); return { status: 'ok', authMode: options.authMode ?? 'firebase' }; }
    catch { return reply.code(503).send({ status: 'unavailable' }); }
  });
  app.get('/', async () => ({ service: 'むさしの玉屋 会員サービス', health: '/health', privacy: '/privacy', support: '/support' }));
  for (const [route, title, field] of [
    ['/privacy', 'プライバシーポリシー', 'privacyText'], ['/terms', '会員サービス利用規約', 'termsText'], ['/support', 'お問い合わせ', 'supportText'],
  ] as const) app.get(route, async (_request, reply) => {
    const store = await db.getStore(options.storeId);
    return reply.type('text/html; charset=utf-8').send(page(`${store.name} ${title}`, store.legal[field], `会員サービス運営者：${store.operator.name}　お問い合わせ電話：${store.operator.phone}`));
  });
  app.get(base, { schema: { params: paramsSchema() } }, async (request) => db.getStore(configuredStore(request)));
  app.get(`${base}/notices`, { schema: { params: paramsSchema() } }, async (request) => db.listNotices(configuredStore(request)));
  app.get(`${base}/me`, { schema: { params: paramsSchema() } }, async (request) => db.getMe(params(request).storeId, await identity(request)));
  app.post(`${base}/me/register`, {
    schema: { params: paramsSchema(), body: object({ nickname: text(20), acceptedTermsVersion: text(80), acceptedPrivacyVersion: text(80) }) },
  }, async (request) => {
    const actor = await identity(request); mutation(request, actor);
    return db.register(params(request).storeId, actor, request.body as { nickname: string; acceptedTermsVersion: string; acceptedPrivacyVersion: string });
  });
  app.patch(`${base}/me`, { schema: { params: paramsSchema(), body: object({ nickname: text(20) }) } }, async (request) => {
    const actor = await identity(request); mutation(request, actor);
    return db.updateNickname(params(request).storeId, actor, (request.body as { nickname: string }).nickname);
  });
  app.delete(`${base}/me`, {
    schema: { params: paramsSchema(), body: object({ confirmation: { type: 'string', const: '退会する' } }) },
  }, async (request, reply) => {
    const actor = await identity(request, true); mutation(request, actor);
    const age = Math.floor(now().getTime() / 1000) - actor.authTime;
    if (!Number.isFinite(age) || age < -60 || age > 300) throw new DomainError('RECENT_LOGIN_REQUIRED', 401, '安全のため、パスワードでもう一度本人確認をしてください。');
    await db.requestDeletion(params(request).storeId, actor);
    await processDeletionJobs(db, verifier, options.projectId);
    const status = await db.deletionStatus(actor.projectId, actor.uid);
    return reply.code(status === 'pending' ? 202 : 200).send({ status });
  });
  app.get(`${base}/me/qr`, { schema: { params: paramsSchema() } }, async (request) => {
    const own = await db.getMe(params(request).storeId, await identity(request));
    if (!own.member) throw new DomainError('MEMBER_NOT_FOUND', 404, '先に会員登録を完了してください。');
    return createMemberQr({ storeId: params(request).storeId, memberId: own.member.id }, options.qrSecret, now());
  });
  app.post(`${base}/staff/resolve-qr`, { schema: { params: paramsSchema(), body: object({ qr: text(2048) }) } }, async (request) => {
    const actor = await staff(request);
    const qr = readMemberQr((request.body as { qr: string }).qr, params(request).storeId, options.qrSecret, now());
    return db.getMember(qr.storeId, qr.memberId, actor);
  });
  app.get(`${base}/staff/members`, { schema: { params: paramsSchema(), querystring: object({ query: text(80) }) } }, async (request) => {
    const actor = await staff(request);
    return db.listMembers(params(request).storeId, (request.query as { query: string }).query, actor);
  });
  app.get(`${base}/staff/members/:memberId`, { schema: { params: paramsSchema({ memberId: text(128) }) } }, async (request) => db.getMember(params(request).storeId, params(request).memberId!, await staff(request)));
  app.post(`${base}/staff/members/:memberId/stamps`, { schema: { params: paramsSchema({ memberId: text(128) }), body: purchaseBody } }, async (request) => {
    const actor = await staff(request);
    return db.grantStamp(params(request).storeId, params(request).memberId!, (request.body as { purchaseAmountYen: number }).purchaseAmountYen, mutation(request, actor));
  });
  app.post(`${base}/staff/coupons/:couponId/redeem`, { schema: { params: paramsSchema({ couponId: text(128) }), body: purchaseBody } }, async (request) => {
    const actor = await staff(request);
    return db.redeemCoupon(params(request).storeId, params(request).couponId!, (request.body as { purchaseAmountYen: number }).purchaseAmountYen, mutation(request, actor));
  });
  app.get(`${base}/staff/stats`, { schema: { params: paramsSchema() } }, async (request) => db.stats(params(request).storeId, await staff(request)));
  app.post(`${base}/staff/notices`, { schema: { params: paramsSchema(), body: noticeBody } }, async (request) => {
    const actor = await staff(request);
    return db.saveNotice(params(request).storeId, request.body as { title: string; body: string }, mutation(request, actor));
  });
  app.put(`${base}/staff/notices/:id`, { schema: { params: paramsSchema({ id: text(128) }), body: noticeBody } }, async (request) => {
    const actor = await staff(request);
    return db.saveNotice(params(request).storeId, { ...request.body as { title: string; body: string }, id: params(request).id! }, mutation(request, actor));
  });
  app.get(`${base}/owner/staff`, { schema: { params: paramsSchema() } }, async (request) => db.listStaff(params(request).storeId, await staff(request, true)));
  app.put(`${base}/owner/staff/:uid`, {
    schema: { params: paramsSchema({ uid: text(128) }), body: object({ role: { type: 'string', enum: ['owner', 'staff'] }, active: { type: 'boolean' } }) },
  }, async (request) => {
    const actor = await staff(request, true);
    const body = request.body as { role: StaffRole; active: boolean };
    if (body.active) await verifier.verifyStaffUid(params(request).uid!);
    return db.setStaff(params(request).storeId, params(request).uid!, body.role, body.active, mutation(request, actor));
  });
  app.get(`${base}/owner/audit`, { schema: { params: paramsSchema() } }, async (request) => db.audit(params(request).storeId, await staff(request, true)));
  return app;
}
