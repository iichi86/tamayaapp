import type { ProductionApi, AuthPort } from './ports';
import type { ApiErrorBody } from '../../shared/contracts';

export class ApiError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) { super(message); }
}
export interface RequestJournal {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
export interface ApiClientOptions {
  baseUrl: string; storeId: string; auth: AuthPort; journal: RequestJournal;
  randomId(): string; fingerprint(input: string): Promise<string>;
  fetchImpl?: typeof fetch; timeoutMs?: number;
}

/** Unknown mutation results keep their operation ID, including across app restarts. */
export function createProductionApi(options: ApiClientOptions): ProductionApi {
  const fetcher = options.fetchImpl ?? fetch;
  const base = `${options.baseUrl}/v1/stores/${encodeURIComponent(options.storeId)}`;
  const inFlight = new Map<string, Promise<unknown>>();
  async function request<T>(path: string, method = 'GET', body?: unknown, publicRead = false): Promise<T> {
    const uid = options.auth.getSnapshot().user?.uid;
    const token = publicRead ? null : await options.auth.getIdToken();
    if (!publicRead && (!uid || !token)) throw new ApiError('UNAUTHENTICATED', 401, 'ログインしてください。');
    if (!publicRead && options.auth.getSnapshot().user?.uid !== uid) throw new ApiError('ACCOUNT_CHANGED', 401, 'ログイン中の会員が変わりました。もう一度開き直してください。');
    const mutation = method !== 'GET';
    const operation = await options.fingerprint(`${uid ?? 'public'}:${options.storeId}:${method}:${path}:${JSON.stringify(body)}`);
    if (mutation && inFlight.has(operation)) return inFlight.get(operation) as Promise<T>;
    const perform = async (): Promise<T> => {
      const journalKey = `tamaya.production.operation.v1.${operation}`;
      let key: string | null = null;
      if (mutation) {
        key = await options.journal.get(journalKey);
        if (!key) { key = options.randomId(); await options.journal.set(journalKey, key); }
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
      try {
        if (!publicRead && options.auth.getSnapshot().user?.uid !== uid) throw new ApiError('ACCOUNT_CHANGED', 401, 'ログイン中の会員が変わりました。もう一度開き直してください。');
        const response = await fetcher(`${base}${path}`, {
          method, signal: controller.signal, credentials: 'omit', cache: 'no-store',
          headers: {
            Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(key ? { 'Idempotency-Key': key } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const payload = await response.json() as T | ApiErrorBody;
        if (!response.ok) {
          if (mutation && [400, 404, 409, 422].includes(response.status)) await options.journal.remove(journalKey);
          const error = (payload as ApiErrorBody)?.error;
          throw new ApiError(error?.code ?? 'REQUEST_FAILED', response.status,
            error?.message ?? '処理できませんでした。時間をおいて再度お試しください。');
        }
        if (mutation) await options.journal.remove(journalKey);
        if (!publicRead && options.auth.getSnapshot().user?.uid !== uid) {
          throw new ApiError('ACCOUNT_CHANGED', 401, 'ログイン中の会員が変わりました。もう一度開き直してください。');
        }
        return payload as T;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError('NETWORK_ERROR', 0, mutation
          ? '通信を確認できません。結果が保存されている場合があります。通信が戻ったら更新するか、同じ操作を再試行してください。'
          : '通信できません。インターネット接続を確認して、更新してください。');
      } finally { clearTimeout(timeout); }
    };
    const promise = perform();
    if (mutation) inFlight.set(operation, promise);
    try { return await promise; } finally { if (mutation) inFlight.delete(operation); }
  }
  return {
    store: () => request('', 'GET', undefined, true),
    notices: () => request('/notices', 'GET', undefined, true),
    me: () => request('/me'),
    register: (input) => request('/me/register', 'POST', input),
    updateNickname: (nickname) => request('/me', 'PATCH', { nickname }),
    qr: () => request('/me/qr'),
    deleteAccount: () => request('/me', 'DELETE', { confirmation: '退会する' }),
    staffMembers: (query) => request(`/staff/members?query=${encodeURIComponent(query)}`),
    staffMember: (id) => request(`/staff/members/${encodeURIComponent(id)}`),
    resolveQr: (qr) => request('/staff/resolve-qr', 'POST', { qr }),
    grantStamp: (id, purchaseAmountYen) => request(`/staff/members/${encodeURIComponent(id)}/stamps`, 'POST', { purchaseAmountYen }),
    redeemCoupon: (id, purchaseAmountYen = 0) => request(`/staff/coupons/${encodeURIComponent(id)}/redeem`, 'POST', { purchaseAmountYen }),
    saveNotice: ({ id, ...input }) => request(`/staff/notices${id ? `/${encodeURIComponent(id)}` : ''}`, id ? 'PUT' : 'POST', input),
    stats: () => request('/staff/stats'),
    staffAccounts: () => request('/owner/staff'),
    setStaffAccount: (uid, input) => request(`/owner/staff/${encodeURIComponent(uid)}`, 'PUT', input),
    audit: () => request('/owner/audit'),
  };
}
