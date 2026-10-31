import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import type { ServerMember, StoreInfo } from '../shared/contracts';

// Only test-process code reads this local, disposable PostgreSQL fixture.
// The Expo bundle contains neither this URL nor Firebase Admin credentials.
const serverRequire = createRequire(resolve(process.cwd(), 'server/package.json'));
const { Pool } = serverRequire('pg');
const { initializeApp, getApps } = serverRequire('firebase-admin/app');
const { getAuth } = serverRequire('firebase-admin/auth');
const projectId = 'demo-tamaya-production';
const authBase = 'http://127.0.0.1:9099';
const apiBase = 'http://127.0.0.1:3002/v1/stores/tamaya';
const password = 'LocalTestOnly-2026';
const dbUrl = 'postgresql://tamaya_local:local-validation-only@127.0.0.1:54330/tamaya_local';
const fixtures = {
  owner: { uid: 'e2e-owner', email: 'owner@example.test' },
  staff: { uid: 'e2e-staff', email: 'staff@example.test' },
  four: { uid: 'e2e-four', email: 'four@example.test' },
  futureStaff: { uid: 'e2e-future-staff', email: 'futurestaff@example.test' },
};
let four: ServerMember;
let expiredCouponId: string;

async function authSignIn(email: string, currentPassword = password): Promise<{ idToken: string; localId: string }> {
  const response = await fetch(`${authBase}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=local-emulator-only`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: currentPassword, returnSecureToken: true }),
  });
  expect(response.status, `Local Firebase login for ${email}`).toBe(200);
  return response.json();
}
async function apiRequest(path: string, token: string, init: RequestInit = {}) {
  return fetch(`${apiBase}${path}`, {
    ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': randomUUID(), ...init.headers },
  });
}
async function me(email: string, currentPassword = password): Promise<ServerMember> {
  const token = await authSignIn(email, currentPassword);
  const response = await apiRequest('/me', token.idToken);
  expect(response.status).toBe(200);
  return (await response.json()).member;
}
async function closeNotice(page: Page, text?: string | RegExp) {
  if (text) await expect(page.getByText(text, { exact: typeof text === 'string' })).toBeVisible();
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
}
async function login(page: Page, email: string, currentPassword = password) {
  await page.goto('/');
  await page.getByRole('tab', { name: '会員証', exact: true }).click();
  await page.getByRole('textbox', { name: 'メールアドレス', exact: true }).fill(email);
  await page.getByLabel('パスワード', { exact: true }).fill(currentPassword);
  await page.getByRole('button', { name: 'ログインする', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログインする', exact: true })).toHaveCount(0);
}
async function newLoggedIn(browser: Browser, email: string): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ viewport: { width: 390, height: 1000 } });
  const page = await context.newPage(); await login(page, email); return { page, context };
}
async function settings(page: Page) {
  await page.getByRole('button', { name: 'アカウントと設定を開く', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'アカウントと設定', exact: true })).toBeVisible();
}
async function staffScreen(page: Page) {
  await settings(page); await page.getByRole('button', { name: '店舗スタッフの画面へ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'お店の管理', exact: true })).toBeVisible();
}
async function findFour(page: Page) {
  await page.getByRole('textbox', { name: '会員番号またはニックネーム', exact: true }).fill(four.number);
  await page.getByRole('button', { name: '会員を検索する', exact: true }).click();
  await page.getByRole('button', { name: '四つの会員さんの会員情報を開く', exact: true }).click();
}
async function capture(page: Page, name: string) {
  mkdirSync(resolve('docs/screenshots/production'), { recursive: true });
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) if (element.scrollTop) element.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: resolve(`docs/screenshots/production/${name}.png`), animations: 'disabled' });
}
async function emulatorCodes(email: string, type: string) {
  const response = await fetch(`${authBase}/emulator/v1/projects/${projectId}/oobCodes`);
  expect(response.status).toBe(200);
  const { oobCodes } = await response.json() as { oobCodes: { email: string; requestType: string; oobCode: string; oobLink: string }[] };
  return oobCodes.filter((code) => code.email === email && code.requestType === type).at(-1);
}

test.beforeAll(async () => {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
  const adminApp = getApps().find((app: { name: string }) => app.name === 'production-browser-tests')
    ?? initializeApp({ projectId }, 'production-browser-tests');
  const auth = getAuth(adminApp);
  await fetch(`${authBase}/emulator/v1/projects/${projectId}/accounts`, { method: 'DELETE' });
  for (const user of Object.values(fixtures)) await auth.createUser({ ...user, password, emailVerified: true });
  const pool = new Pool({ connectionString: dbUrl });
  try {
    await pool.query('TRUNCATE tamaya.staff,tamaya.members,tamaya.stamp_events,tamaya.coupons,tamaya.notices,tamaya.audit_log,tamaya.idempotency,tamaya.deletion_jobs CASCADE');
    await pool.query("INSERT INTO tamaya.staff(store_id,uid,role,active) VALUES('tamaya',$1,'owner',true),('tamaya',$2,'staff',true)", [fixtures.owner.uid, fixtures.staff.uid]);
    const store = await (await fetch(apiBase)).json() as StoreInfo;
    const token = await authSignIn(fixtures.four.email);
    const response = await apiRequest('/me/register', token.idToken, { method: 'POST', body: JSON.stringify({
      nickname: '四つの会員', acceptedTermsVersion: store.legal.termsVersion, acceptedPrivacyVersion: store.legal.privacyVersion,
    }) });
    expect(response.status).toBe(200); four = await response.json();
    const futureToken = await authSignIn(fixtures.futureStaff.email);
    const futureMembership = await apiRequest('/me/register', futureToken.idToken, { method: 'POST', body: JSON.stringify({
      nickname: '追加するスタッフ', acceptedTermsVersion: store.legal.termsVersion, acceptedPrivacyVersion: store.legal.privacyVersion,
    }) });
    expect(futureMembership.status, 'Staff invitations target an existing verified membership').toBe(200);
    await pool.query('UPDATE tamaya.members SET stamps=4 WHERE id=$1', [four.id]);
    for (let days = 4; days >= 1; days--) {
      const when = new Date(Date.now() - days * 86_400_000);
      const japanDate = new Date(when.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
      await pool.query('INSERT INTO tamaya.stamp_events(id,store_id,member_id,japan_date,created_at,purchase_amount_yen) VALUES($1,\'tamaya\',$2,$3,$4,500)', [randomUUID(), four.id, japanDate, when]);
    }
    expiredCouponId = randomUUID();
    await pool.query('INSERT INTO tamaya.coupons(id,store_id,member_id,issued_at,expires_at,policy_version,benefit,eligible_products,combination_rule) VALUES($1,\'tamaya\',$2,$3,$4,$5,$6,$7,$8)', [
      expiredCouponId, four.id, new Date(Date.now() - 100 * 86_400_000), new Date(Date.now() - 10 * 86_400_000), 'local-test-only',
      JSON.stringify({ kind: 'item', label: '期限切れの検証用特典' }), JSON.stringify(['生菓子', 'ギフト商品']), '検証用・併用不可',
    ]);
  } finally { await pool.end(); }
});

test('actual email verification, zero-stamp registration, persistence, recovery, password reset and deletion', async ({ browser }) => {
  const email = `new-${randomUUID()}@example.test`;
  let context = await browser.newContext({ viewport: { width: 390, height: 1000 } });
  let page = await context.newPage();
  await page.goto('/'); await page.getByRole('tab', { name: '会員証', exact: true }).click();
  await page.getByRole('button', { name: 'はじめての方：会員登録', exact: true }).click();
  await page.getByRole('textbox', { name: 'メールアドレス', exact: true }).fill(email);
  await page.getByLabel('パスワード', { exact: true }).fill(password);
  await page.getByRole('button', { name: '利用規約を読む', exact: true }).click();
  await expect(page.getByRole('heading', { name: '利用規約', exact: true })).toBeVisible(); await closeNotice(page);
  await page.getByRole('checkbox', { name: '利用規約とプライバシーポリシーに同意する', exact: true }).click();
  await page.getByRole('button', { name: '確認メールを送って登録する', exact: true }).click();
  await closeNotice(page, '確認メールを送信しました。メール内のリンクを開いてから、このアプリに戻ってください。');
  await expect(page.getByRole('heading', { name: 'メールアドレスの確認', exact: true })).toBeVisible();
  const unverified = await authSignIn(email);
  expect((await apiRequest('/me', unverified.idToken)).status, 'Unverified Firebase login cannot access membership').toBe(403);
  await expect.poll(async () => !!(await emulatorCodes(email, 'VERIFY_EMAIL'))).toBe(true);
  const code = (await emulatorCodes(email, 'VERIFY_EMAIL'))!;
  const verify = await fetch(`${authBase}/identitytoolkit.googleapis.com/v1/accounts:update?key=local-emulator-only`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oobCode: code.oobCode }),
  });
  expect(verify.status, 'Apply the genuine emulator-generated email confirmation code').toBe(200);
  await page.getByRole('button', { name: 'メール確認後、会員登録へ進む', exact: true }).click();
  await page.getByRole('textbox', { name: 'ニックネーム', exact: true }).fill('新しい会員');
  await page.getByRole('checkbox', { name: '利用規約とプライバシーポリシーに同意する', exact: true }).click();
  await page.getByRole('button', { name: '会員登録して会員証を表示', exact: true }).click();
  await closeNotice(page, '会員登録が完了しました。');
  await expect(page.getByLabel('スタンプ5個中0個', { exact: true })).toBeVisible();
  const registered = await me(email); expect(registered.stamps).toBe(0);
  await expect(page.getByText(`会員番号 ${registered.number}`, { exact: true })).toBeVisible();
  await capture(page, 'member');
  await page.getByRole('tab', { name: 'ホーム', exact: true }).click(); await capture(page, 'home');
  await page.reload(); await expect(page.getByText('新しい会員さん、こんにちは。', { exact: true })).toBeVisible();
  await context.close();

  // A new browser context has no prior session/storage, matching another device signing in.
  ({ context, page } = await newLoggedIn(browser, email));
  await expect(page.getByText(`会員番号 ${registered.number}`, { exact: true })).toBeVisible();
  await settings(page); await page.getByRole('button', { name: 'ログアウトする', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログインする', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'パスワードを忘れた方', exact: true }).click();
  await page.getByRole('textbox', { name: 'メールアドレス', exact: true }).fill(email);
  await page.getByRole('button', { name: '再設定メールを送る', exact: true }).click();
  await closeNotice(page, '該当するアカウントがある場合は、再設定メールを送信します。受信箱と迷惑メールをご確認ください。');
  const resetCode = (await emulatorCodes(email, 'PASSWORD_RESET'))!;
  expect(resetCode).toBeTruthy();
  const newPassword = 'ChangedLocalOnly-2026';
  expect((await fetch(`${authBase}/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=local-emulator-only`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oobCode: resetCode.oobCode, newPassword }),
  })).status).toBe(200);
  await page.getByRole('button', { name: 'ログイン画面に戻る', exact: true }).click();
  await page.getByLabel('パスワード', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: 'ログインする', exact: true }).click();
  await expect(page.getByText(`会員番号 ${registered.number}`, { exact: true })).toBeVisible();
  await settings(page); await page.getByRole('button', { name: '退会・アカウント削除', exact: true }).click();
  await page.getByLabel('本人確認のため現在のパスワード', { exact: true }).fill(newPassword);
  await page.getByRole('textbox', { name: '確認のため「退会する」と入力', exact: true }).fill('退会する');
  await page.getByRole('button', { name: '確認してアカウントを削除する', exact: true }).click();
  await closeNotice(page, '退会とアカウント削除が完了しました。');
  await expect(page.getByRole('button', { name: 'ログインする', exact: true })).toBeVisible();
  const pool = new Pool({ connectionString: dbUrl });
  try { expect((await pool.query('SELECT 1 FROM tamaya.members WHERE id=$1', [registered.id])).rowCount).toBe(0); }
  finally { await pool.end(); }
  await context.close();
});

test('separate customer/staff/owner sessions issue and redeem once, protect expired rewards and administer staff', async ({ browser }) => {
  const customer = await newLoggedIn(browser, fixtures.four.email);
  const staff = await newLoggedIn(browser, fixtures.staff.email);
  const owner = await newLoggedIn(browser, fixtures.owner.email);
  try {
    await expect(customer.page.getByLabel('スタンプ5個中4個', { exact: true })).toBeVisible();
    const qrImage = PNG.sync.read(await customer.page.locator('svg').screenshot({ animations: 'disabled' }));
    const qr = jsQR(new Uint8ClampedArray(qrImage.data), qrImage.width, qrImage.height);
    expect(qr?.data).toMatch(/^tamaya-member:v1\./);
    const staffToken = (await authSignIn(fixtures.staff.email)).idToken;
    const customerToken = (await authSignIn(fixtures.four.email)).idToken;
    const resolved = await apiRequest('/staff/resolve-qr', staffToken, { method: 'POST', body: JSON.stringify({ qr: qr!.data }) });
    expect(resolved.status).toBe(200); expect((await resolved.json()).id).toBe(four.id);
    expect((await apiRequest('/staff/stats', customerToken)).status, 'Customer has no staff privilege').toBe(403);
    await staffScreen(staff.page); await capture(staff.page, 'staff'); await findFour(staff.page);
    await staff.page.getByRole('textbox', { name: '今回のお会計金額（円）', exact: true }).fill('499');
    await expect(staff.page.getByRole('button', { name: 'スタンプ付与の確認へ', exact: true })).toBeDisabled();
    const belowMinimum = await apiRequest(`/staff/members/${four.id}/stamps`, staffToken, { method: 'POST', body: JSON.stringify({ purchaseAmountYen: 499 }) });
    expect(belowMinimum.status, 'The server independently rejects purchases below 500 yen').toBe(409);
    await staff.page.getByRole('textbox', { name: '今回のお会計金額（円）', exact: true }).fill('500');
    await staff.page.getByRole('button', { name: 'スタンプ付与の確認へ', exact: true }).click();
    await staff.page.getByRole('button', { name: 'キャンセル', exact: true }).click();
    expect((await me(fixtures.four.email)).stamps, 'Cancel confirmation leaves balance intact').toBe(4);
    await staff.page.getByRole('button', { name: 'スタンプ付与の確認へ', exact: true }).click();
    await staff.page.getByRole('button', { name: '確認して1スタンプ付与', exact: true }).click();
    await expect(staff.page.getByText('1スタンプを付与し、特典を1枚発行しました。', { exact: true })).toBeVisible();
    await expect(staff.page.getByRole('button', { name: '本日は付与済みです', exact: true })).toBeDisabled();
    const issued = await me(fixtures.four.email);
    expect(issued.stamps).toBe(0); expect(issued.coupons.filter((coupon) => coupon.status === 'available')).toHaveLength(1);
    const earned = issued.coupons.find((coupon) => coupon.status === 'available')!;
    expect(Date.parse(earned.expiresAt) - Date.parse(earned.issuedAt)).toBe(90 * 86_400_000);
    const duplicate = await apiRequest(`/staff/members/${four.id}/stamps`, staffToken, { method: 'POST', body: JSON.stringify({ purchaseAmountYen: 500 }) });
    expect(duplicate.status).toBe(409);
    expect((await me(fixtures.four.email)).coupons.filter((coupon) => coupon.status === 'available')).toHaveLength(1);
    await customer.page.reload(); await customer.page.getByRole('tab', { name: '特典', exact: true }).click();
    await capture(customer.page, 'coupons');
    await customer.page.getByRole('button', { name: `${earned.benefit.label}、未使用。詳細を開く`, exact: true }).click();
    await expect(customer.page.getByRole('heading', { name: '店頭でご提示ください', exact: true })).toBeVisible();
    await expect(customer.page.getByRole('dialog').getByText('未使用', { exact: true })).toBeVisible();
    await capture(customer.page, 'coupon-detail');
    if (earned.redemptionMinimumPurchaseYen > 0) await staff.page.getByRole('textbox', { name: '特典利用時のお会計金額（円）', exact: true }).fill(String(earned.redemptionMinimumPurchaseYen));
    await staff.page.getByRole('button', { name: '特典利用の確認へ', exact: true }).click();
    await staff.page.getByRole('button', { name: '確認して使用済みにする', exact: true }).click();
    await expect(staff.page.getByText('特典を使用済みにしました。', { exact: true })).toBeVisible();
    // Keep the detail open while another device changes it; foreground refresh must use the latest DTO.
    await customer.page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
    await expect(customer.page.getByRole('dialog').getByText('使用済み', { exact: true })).toBeVisible({ timeout: 40_000 });
    await expect(customer.page.getByText('この特典は利用できません。', { exact: true })).toBeVisible();
    expect((await apiRequest(`/staff/coupons/${earned.id}/redeem`, staffToken, { method: 'POST', body: JSON.stringify({ purchaseAmountYen: earned.redemptionMinimumPurchaseYen }) })).status).toBe(409);
    expect((await apiRequest(`/staff/coupons/${expiredCouponId}/redeem`, staffToken, { method: 'POST', body: JSON.stringify({ purchaseAmountYen: 0 }) })).status).toBe(409);
    await staff.page.getByRole('button', { name: 'お知らせを追加', exact: true }).click();
    await staff.page.getByRole('textbox', { name: 'お知らせの見出し', exact: true }).fill('連携を確認しました');
    await staff.page.getByRole('textbox', { name: 'お知らせの本文', exact: true }).fill('架空のデータでサーバーとの保存・読み込みを確認しています。');
    await staff.page.getByRole('button', { name: 'お知らせを保存', exact: true }).click();
    await expect(staff.page.getByText('お知らせを公開しました。', { exact: true })).toBeVisible();
    await capture(staff.page, 'staff-notices');
    await closeNotice(customer.page); await customer.page.getByRole('tab', { name: 'ホーム', exact: true }).click();
    await customer.page.reload(); await expect(customer.page.getByText('連携を確認しました', { exact: true })).toBeVisible();
    await staffScreen(owner.page);
    await owner.page.getByRole('textbox', { name: '追加するスタッフのUID', exact: true }).fill(fixtures.futureStaff.uid);
    await owner.page.getByRole('button', { name: '権限を追加する確認へ', exact: true }).click();
    await owner.page.getByRole('button', { name: '確認して権限を変更', exact: true }).click();
    await expect(owner.page.getByText('スタッフ権限を保存しました。', { exact: true })).toBeVisible();
    const futureToken = (await authSignIn(fixtures.futureStaff.email)).idToken;
    expect((await apiRequest('/staff/stats', futureToken)).status).toBe(200);
    const futureAccount = owner.page.getByText(`UID ${fixtures.futureStaff.uid}`, { exact: true }).locator('..');
    await futureAccount.getByRole('button', { name: 'この人のスタッフ権限を停止する', exact: true }).click();
    await owner.page.getByRole('button', { name: '確認して権限を変更', exact: true }).click();
    await expect(owner.page.getByText('スタッフ権限を停止しました。', { exact: true })).toBeVisible();
    expect((await apiRequest('/staff/stats', futureToken)).status, 'Previously issued token cannot retain stopped staff access').toBe(403);
    const stats = await (await apiRequest('/staff/stats', staffToken)).json();
    expect(stats.stampsToday).toBe(1); expect(stats.redemptionsToday).toBe(1);
  } finally { await customer.context.close(); await staff.context.close(); await owner.context.close(); }
});

test('small screens and larger browser text retain four customer routes and usable controls', async ({ browser }) => {
  const customer = await newLoggedIn(browser, fixtures.four.email);
  try {
    for (const width of [390, 320]) {
      await customer.page.setViewportSize({ width, height: 900 });
      for (const scale of [1, 1.35]) {
        for (const tab of ['ホーム', '会員証', '特典', 'お店']) {
          await customer.page.getByRole('tab', { name: tab, exact: true }).click();
          await customer.page.evaluate((factor) => {
            // React Native Web emits static font sizes as CSS classes, not only inline styles.
            // Capture all computed originals before applying any changes to avoid scaling inherited text twice.
            const text = Array.from(document.querySelectorAll<HTMLElement>('[dir="auto"],input,textarea')).map((element) => {
              const computed = getComputedStyle(element);
              const font = element.dataset.testOriginalFont ?? computed.fontSize;
              const line = element.dataset.testOriginalLine ?? computed.lineHeight;
              return { element, font, line };
            });
            for (const { element, font, line } of text) {
              element.dataset.testOriginalFont = font; element.style.fontSize = `${parseFloat(font) * factor}px`;
              if (Number.isFinite(parseFloat(line))) { element.dataset.testOriginalLine = line; element.style.lineHeight = `${parseFloat(line) * factor}px`; }
            }
          }, scale);
          expect(await customer.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${tab} width${width}, browserfont${scale}`).toBe(true);
          const controls = customer.page.getByRole('button');
          for (let index = 0; index < await controls.count(); index++) {
            const button = controls.nth(index);
            if (!(await button.isVisible())) continue;
            const box = await button.boundingBox();
            expect(box?.height, `${tab}: ${await button.getAttribute('aria-label')}`).toBeGreaterThanOrEqual(48);
            expect(box!.x).toBeGreaterThanOrEqual(-1); expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
          }
        }
      }
    }
    await customer.page.getByRole('tab', { name: 'お店', exact: true }).click();
    await expect(customer.page.getByText('東京都中野区本町4-30-14', { exact: true })).toBeVisible();
    await expect(customer.page.getByText('03-3381-7012', { exact: true })).toBeVisible();
    await expect(customer.page.getByText('10:00〜19:00（基本定休日：月曜日）', { exact: true })).toBeVisible();
    await expect(customer.page.getByRole('button', { name: '店舗に電話する', exact: true })).toBeVisible();
    await expect(customer.page.getByText('会員サービスのお問い合わせ：080-4909-7012', { exact: true })).toBeVisible();
    await expect(customer.page.getByRole('heading', { name: '玉屋のお菓子', exact: true })).toHaveCount(0);
    for (const name of ['どら焼き', '鍋横最中', '長者もち', 'お赤飯']) {
      await expect(customer.page.getByText(name, { exact: true })).toHaveCount(0);
    }
    // Exercise the actual map button without navigating to an external service.
    await customer.page.evaluate(() => {
      const state = window as unknown as { storeOriginalOpen: typeof window.open; storeOpenedUrl?: string };
      state.storeOriginalOpen = window.open;
      window.open = ((url) => { state.storeOpenedUrl = String(url); return null; }) as typeof window.open;
    });
    try {
      await customer.page.getByRole('button', { name: '地図で住所を開く', exact: true }).click();
      const value = await customer.page.evaluate(() => (window as unknown as { storeOpenedUrl?: string }).storeOpenedUrl);
      const map = new URL(value!);
      expect(map.origin).toBe('https://maps.apple.com');
      expect(map.searchParams.get('q')).toBe('むさしの玉屋 東京都中野区本町4-30-14');
    } finally {
      await customer.page.evaluate(() => { window.open = (window as unknown as { storeOriginalOpen: typeof window.open }).storeOriginalOpen; });
    }
    await capture(customer.page, 'shop-small');
  } finally { await customer.context.close(); }
});

test('offline and disabled-account responses remove the usable membership QR and private cached screens', async ({ browser }) => {
  const customer = await newLoggedIn(browser, fixtures.four.email);
  const adminApp = getApps().find((app: { name: string }) => app.name === 'production-browser-tests');
  const auth = getAuth(adminApp);
  try {
    await expect(customer.page.locator('svg')).toBeVisible();
    await expect(customer.page.getByRole('button', { name: 'スタンプ付与の確認へ', exact: true })).toHaveCount(0);
    await customer.context.setOffline(true);
    await settings(customer.page); await customer.page.getByRole('button', { name: '最新の情報に更新', exact: true }).click();
    await expect(customer.page.locator('svg')).toHaveCount(0);
    await customer.context.setOffline(false);
    await customer.page.getByRole('button', { name: '再読み込み', exact: true }).click();
    await expect(customer.page.locator('svg')).toBeVisible();
    await auth.updateUser(fixtures.four.uid, { disabled: true });
    await settings(customer.page); await customer.page.getByRole('button', { name: '最新の情報に更新', exact: true }).click();
    await expect(customer.page.getByText(`会員番号 ${four.number}`, { exact: true })).toHaveCount(0);
    await expect(customer.page.locator('svg')).toHaveCount(0);
    await expect(customer.page.getByRole('button', { name: '店舗スタッフの画面へ', exact: true })).toHaveCount(0);
  } finally { await auth.updateUser(fixtures.four.uid, { disabled: false }); await customer.context.close(); }
});
