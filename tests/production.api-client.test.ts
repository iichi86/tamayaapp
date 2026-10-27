import { describe, expect, it, vi } from 'vitest';
import { createProductionApi, type RequestJournal } from '../src/production/apiClient';
import type { AuthPort, AuthSnapshot } from '../src/production/ports';

function setup(fetchImpl: typeof fetch, storage = new Map<string, string>()) {
  let snapshot: AuthSnapshot = { loading: false, user: { uid: 'customer-a', email: 'fake@example.test', emailVerified: true } };
  const auth: AuthPort = {
    getSnapshot: () => snapshot, subscribe: () => () => {}, getIdToken: async () => 'private-id-token',
    signIn: async () => {}, signUp: async () => {}, signOut: async () => {}, sendVerification: async () => {},
    reloadUser: async () => {}, resetPassword: async () => {}, reauthenticate: async () => {},
  };
  let next = 0;
  const journal: RequestJournal = { get: async (key) => storage.get(key) ?? null, set: async (key, value) => { storage.set(key, value); }, remove: async (key) => { storage.delete(key); } };
  const options = { baseUrl: 'https://api.example.test', storeId: 'tamaya', auth, journal,
    randomId: () => `operation-${++next}`, fingerprint: async (value: string) => value, fetchImpl };
  return { api: createProductionApi(options), options, storage, changeUser: (uid: string) => { snapshot = { ...snapshot, user: { ...snapshot.user!, uid } }; } };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('production transport and durable operation IDs', () => {
  it('reuses an uncertain operation after a restart and clears it only after success', async () => {
    const keys: unknown[] = [];
    let first = true;
    const fetcher = vi.fn(async (_url, init) => {
      keys.push((init?.headers as Record<string, string>)['Idempotency-Key']);
      if (first) { first = false; throw new Error('Connection lost after commit'); }
      return json({ member: { stamps: 0 }, coupon: { id: 'one-coupon' } });
    }) as unknown as typeof fetch;
    const s = setup(fetcher);
    await expect(s.api.grantStamp('member-a', 500)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(s.storage.size).toBe(1);
    const restarted = createProductionApi(s.options);
    await restarted.grantStamp('member-a', 500);
    expect(keys).toEqual(['operation-1', 'operation-1']);
    expect(s.storage.size).toBe(0);
    await restarted.grantStamp('member-a', 500);
    expect(keys[2]).toBe('operation-2');
  });

  it('coalesces repeated taps into one HTTP mutation', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((done) => { resolve = done; })) as unknown as typeof fetch;
    const s = setup(fetcher);
    const one = s.api.redeemCoupon('coupon-a');
    const two = s.api.redeemCoupon('coupon-a');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    resolve(json({ coupon: { status: 'used' } }));
    await expect(Promise.all([one, two])).resolves.toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429, 500, 503])('retains operation ID after retryable/uncertain status %s', async (status) => {
    const s = setup(vi.fn(async () => json({ error: { code: 'ERROR', message: '再試行' } }, status)) as unknown as typeof fetch);
    await expect(s.api.grantStamp('member-a', 500)).rejects.toMatchObject({ status });
    expect(s.storage.size).toBe(1);
  });

  it.each([400, 404, 409, 422])('clears definitively rejected operation after status %s', async (status) => {
    const s = setup(vi.fn(async () => json({ error: { code: 'ERROR', message: '処理不可' } }, status)) as unknown as typeof fetch);
    await expect(s.api.grantStamp('member-a', 500)).rejects.toMatchObject({ status });
    expect(s.storage.size).toBe(0);
  });

  it('never places authentication tokens in a URL or sends credentials on public reads', async () => {
    const fetcher = vi.fn(async () => json({})) as unknown as typeof fetch;
    const s = setup(fetcher);
    await s.api.store(); await s.api.me();
    const calls = vi.mocked(fetcher).mock.calls;
    expect(calls[0][1]?.headers).not.toHaveProperty('Authorization');
    expect(calls[1][1]?.headers).toHaveProperty('Authorization', 'Bearer private-id-token');
    expect(calls.every(([url]) => !String(url).includes('private-id-token'))).toBe(true);
  });

  it('rejects a private response from a previous signed-in identity', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((done) => { finish = done; })) as unknown as typeof fetch;
    const s = setup(fetcher);
    const request = s.api.me();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    s.changeUser('customer-b');
    finish(json({ member: { nickname: 'previous-private-data' } }));
    await expect(request).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED', status: 401 });
  });

  it('refuses mutations while signed out and leaves no operation journal', async () => {
    const fetcher = vi.fn(async () => json({})) as unknown as typeof fetch;
    const s = setup(fetcher);
    s.options.auth.getSnapshot = () => ({ loading: false, user: null });
    s.options.auth.getIdToken = async () => null;
    await expect(s.api.grantStamp('member-a', 500)).rejects.toMatchObject({ status: 401 });
    expect(fetcher).not.toHaveBeenCalled(); expect(s.storage.size).toBe(0);
  });
});
