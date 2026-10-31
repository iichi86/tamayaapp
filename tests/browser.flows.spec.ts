import { expect, test as base, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

const storageKey = '@tamaya/demo/v1';

// Browser contexts start with empty local storage. Every state transition below
// happens through the same customer and staff controls used by the demo.
const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    const recordErrors = (currentPage: Page) => {
      currentPage.on('pageerror', (error) => errors.push(error.message));
      currentPage.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
    };
    recordErrors(page);
    page.context().on('page', recordErrors);
    await use(errors);
    page.context().off('page', recordErrors);
    expect(errors, 'No browser exceptions or console errors').toEqual([]);
  }, { auto: true }],
});

async function openDemoMenu(page: Page) {
  await page.getByRole('button', { name: 'デモメニューを開く' }).click();
  await expect(page.getByRole('heading', { name: 'デモメニュー', exact: true })).toBeVisible();
}

async function closeMessage(page: Page, text: string) {
  const message = page.getByText(text, { exact: true });
  await expect(message).toBeVisible();
  await message.locator('..').getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(message).not.toBeVisible();
  await expect(page.getByRole('button', { name: '閉じる', exact: true })).toHaveCount(0);
}

async function showSample(page: Page) {
  await openDemoMenu(page);
  await page.getByRole('button', { name: /^体験用の会員（サンプル・9スタンプ開始）/ }).click();
  await closeMessage(page, '体験用の会員さんの会員証を表示します。');
}

async function showStaff(page: Page) {
  await openDemoMenu(page);
  await page.getByRole('button', { name: '店舗用に切り替える', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'お店の受付', exact: true })).toBeVisible();
}

async function storedData(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), storageKey);
}

async function register(page: Page, nickname: string) {
  await page.getByRole('tab', { name: '会員証', exact: true }).click();
  await page.getByRole('textbox', { name: 'ニックネーム', exact: true }).fill(nickname);
  await page.getByRole('button', { name: '会員証をつくる', exact: true }).click();
  await closeMessage(page, '会員登録が完了しました。0スタンプからのスタートです。');
  await expect(page.getByRole('heading', { name: 'あなたの会員証', exact: true })).toBeVisible();
}

async function captureScreen(page: Page, name: string) {
  mkdirSync(resolve(process.cwd(), 'docs/screenshots'), { recursive: true });
  await page.evaluate(async () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      // Browser focus can scroll an overflow:hidden flex ancestor as well as a
      // ScrollView. Reset both when framing a complete screen for documentation.
      if (element.scrollTop > 0) element.scrollTop = 0;
    }
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
  const header = await page.getByRole('button', { name: 'デモメニューを開く', exact: true }).boundingBox();
  expect(header?.y, 'Screenshot includes the application header').toBeGreaterThanOrEqual(0);
  await page.screenshot({
    animations: 'disabled',
    path: resolve(process.cwd(), `docs/screenshots/${name}.png`),
    // Exclude Expo's development-only loading indicator from documentation.
    style: '.__expo_fast_refresh { visibility: hidden !important; }',
  });
}

async function captureScreens(page: Page) {
  // A fresh page reads the member/reward saved by the real UI in this context.
  // Set the documentation viewport before loading to avoid resize/focus scroll
  // anchoring, then keep that viewport for the entire capture sequence.
  const capturePage = await page.context().newPage();
  try {
    await capturePage.setViewportSize({ width: 390, height: 1400 });
    await capturePage.goto('/');
    await expect(capturePage.getByRole('button', { name: '会員証をひらく　→', exact: true })).toBeVisible();
    for (const [tab, filename] of [['ホーム', 'home'], ['会員証', 'member'], ['特典', 'coupons'], ['お店', 'shop']]) {
      await capturePage.getByRole('tab', { name: tab, exact: true }).click();
      await captureScreen(capturePage, filename);
    }
    await showStaff(capturePage);
    await expect(capturePage.getByText('デモメニュー', { exact: true })).toHaveCount(0);
    await expect(capturePage.getByRole('button', { name: '閉じる', exact: true })).toHaveCount(0);
    await captureScreen(capturePage, 'staff');
  } finally {
    await capturePage.close();
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'ホーム', exact: true })).toBeVisible();
  await expect(page.getByText('玉屋のスタンプをはじめる', { exact: true })).toBeVisible();
});

test('new registration creates a persistent zero-stamp member and a real SVG QR', async ({ page }) => {
  await page.getByRole('tab', { name: '会員証', exact: true }).click();
  await page.getByRole('button', { name: '会員証をつくる', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('ニックネームを入力してください。');
  await register(page, 'たまちゃん');
  await expect(page.getByLabel('スタンプ10個中0個', { exact: true })).toBeVisible();
  const qr = page.getByLabel('スタッフ読み取り用の会員QRコード。会員番号000002', { exact: true });
  await expect(qr).toBeVisible();
  await expect(qr.locator('svg path')).toHaveCount(1);
  await expect(qr.locator('svg')).toHaveAttribute('viewBox', '0 0 190 190');
  await expect(page.getByRole('button', { name: 'スタンプ付与の確認へ', exact: true })).toHaveCount(0);
  const data = await storedData(page);
  const member = data.members.find((item: { nickname: string }) => item.nickname === 'たまちゃん');
  expect(member).toMatchObject({ stamps: 0, sample: false, number: '000002' });
  expect(data.currentMemberId).toBe(member.id);
  const qrImage = PNG.sync.read(await qr.screenshot({ animations: 'disabled' }));
  const decoded = jsQR(new Uint8ClampedArray(qrImage.data), qrImage.width, qrImage.height);
  expect(decoded?.data, 'Displayed membership QR decodes to this registered member').toBe(`tamaya-demo:v1:${member.id}`);
  await page.reload();
  await page.getByRole('tab', { name: '会員証', exact: true }).click();
  await expect(page.getByLabel('スタッフ読み取り用の会員QRコード。会員番号000002', { exact: true })).toBeVisible();
  await expect(page.getByLabel('スタンプ10個中0個', { exact: true })).toBeVisible();
});

test('staff confirmation issues a reward once, presentation preserves it, and redemption persists', async ({ page }, testInfo) => {
  await showSample(page);
  await page.getByRole('tab', { name: '会員証', exact: true }).click();
  await expect(page.getByLabel('スタンプ10個中9個', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '特典', exact: true }).click();
  await expect(page.getByRole('button', { name: '100円割引、使用済み。詳細をひらく', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '100円割引、期限切れ。詳細をひらく', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '100円割引、未使用。詳細をひらく', exact: true })).toHaveCount(0);
  await showStaff(page);
  await expect(page.getByText('現在 9 スタンプ', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'スタンプ付与の確認へ', exact: true }).click();
  await expect(page.getByRole('heading', { name: '来店を確認しましたか？', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(page.getByText('現在 9 スタンプ', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'スタンプ付与の確認へ', exact: true }).click();
  await page.getByRole('button', { name: '確認して1スタンプ付与', exact: true }).click();
  await closeMessage(page, 'スタンプを付与しました。お客さんの会員証にも反映されます。');
  await expect(page.getByText('現在 0 スタンプ', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '本日は付与済みです', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'このクーポンは利用できません', exact: true })).toHaveCount(2);
  for (const button of await page.getByRole('button', { name: 'このクーポンは利用できません', exact: true }).all()) await expect(button).toBeDisabled();
  await expect(page.getByRole('button', { name: '特典利用の確認へ', exact: true })).toHaveCount(1);
  const earned = (await storedData(page)).coupons.find((item: { id: string }) => !item.id.startsWith('coupon_demo_'));
  expect(earned.usedAt).toBeNull();
  if (testInfo.project.name === 'mobile-390') {
    // These are Chromium captures of the running app, not iPhone screenshots.
    await captureScreens(page);
  }
  await page.getByRole('button', { name: 'お客さんの画面へ戻る', exact: true }).click();
  await page.getByRole('tab', { name: '特典', exact: true }).click();
  await page.getByRole('button', { name: '100円割引、未使用。詳細をひらく', exact: true }).click();
  await page.getByRole('button', { name: '店頭で提示する', exact: true }).click();
  await expect(page.getByRole('heading', { name: '店舗スタッフにお声がけください', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'クーポンを提示する', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'スタッフにご提示ください', exact: true })).toBeVisible();
  await expect(page.getByText(earned.id, { exact: true })).toBeVisible();
  expect((await storedData(page)).coupons.find((item: { id: string }) => item.id === earned.id).usedAt).toBeNull();
  await page.getByRole('button', { name: '提示を終える', exact: true }).click();
  await page.reload();
  await page.getByRole('tab', { name: '会員証', exact: true }).click();
  await expect(page.getByLabel('スタンプ10個中0個', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '未使用の特典を見る（1件）', exact: true })).toBeVisible();
  await showStaff(page);
  await expect(page.getByRole('button', { name: '本日は付与済みです', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '特典利用の確認へ', exact: true }).click();
  await expect(page.getByText(`特典番号 ${earned.id}`, { exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  expect((await storedData(page)).coupons.find((item: { id: string }) => item.id === earned.id).usedAt).toBeNull();
  await page.getByRole('button', { name: '特典利用の確認へ', exact: true }).click();
  await page.getByRole('button', { name: '確認して使用済みにする', exact: true }).click();
  await closeMessage(page, 'クーポンを使用済みにしました。');
  await expect(page.getByRole('button', { name: '特典利用の確認へ', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'このクーポンは利用できません', exact: true })).toHaveCount(3);
  for (const button of await page.getByRole('button', { name: 'このクーポンは利用できません', exact: true }).all()) await expect(button).toBeDisabled();
  await page.getByRole('button', { name: 'お客さんの画面へ戻る', exact: true }).click();
  await page.getByRole('tab', { name: '特典', exact: true }).click();
  await expect(page.getByRole('button', { name: '100円割引、使用済み。詳細をひらく', exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: '100円割引、期限切れ。詳細をひらく', exact: true })).toHaveCount(1);
  await page.getByRole('tab', { name: '未使用', exact: true }).click();
  await expect(page.getByText('未使用の特典はありません', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: '特典', exact: true }).click();
  await expect(page.getByRole('button', { name: '100円割引、使用済み。詳細をひらく', exact: true })).toHaveCount(2);
  const saved = await storedData(page);
  expect(saved.stamps.filter((item: { source: string }) => item.source === 'visit')).toHaveLength(1);
  expect(saved.coupons.find((item: { id: string }) => item.id === earned.id).usedAt).not.toBeNull();
});

test('staff notices reach customers and reset requires explicit confirmation', async ({ page }) => {
  await register(page, 'お知らせ会員');
  await showStaff(page);
  await page.getByRole('button', { name: 'お知らせを追加', exact: true }).click();
  await expect(page.getByRole('button', { name: 'お知らせを保存', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: 'お知らせの見出し', exact: true }).fill('今月のご案内');
  await page.getByRole('textbox', { name: 'お知らせの本文', exact: true }).fill('来店スタンプをお楽しみください。');
  await page.getByRole('button', { name: 'お知らせを保存', exact: true }).click();
  await closeMessage(page, 'お知らせを保存しました。');
  await page.getByRole('button', { name: '「今月のご案内」を編集', exact: true }).click();
  await page.getByRole('textbox', { name: 'お知らせの見出し', exact: true }).fill('更新したご案内');
  await page.getByRole('textbox', { name: 'お知らせの本文', exact: true }).fill('内容を更新しました。');
  await page.getByRole('button', { name: 'お知らせを保存', exact: true }).click();
  await closeMessage(page, 'お知らせを保存しました。');
  await page.getByRole('button', { name: 'お客さんの画面へ戻る', exact: true }).click();
  await page.getByRole('tab', { name: 'ホーム', exact: true }).click();
  await expect(page.getByText('更新したご案内', { exact: true })).toBeVisible();
  await expect(page.getByText('内容を更新しました。', { exact: true })).toBeVisible();
  const before = await storedData(page);
  await openDemoMenu(page);
  await page.getByRole('button', { name: 'デモデータをリセット', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'デモデータをリセットしますか？', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  expect(await storedData(page)).toEqual(before);
  await page.reload();
  await expect(page.getByText('更新したご案内', { exact: true })).toBeVisible();
  await openDemoMenu(page);
  await page.getByRole('button', { name: 'デモデータをリセット', exact: true }).click();
  await page.getByRole('button', { name: 'リセットする', exact: true }).click();
  await closeMessage(page, '初期状態に戻しました。');
  await expect(page.getByText('玉屋のスタンプをはじめる', { exact: true })).toBeVisible();
  await expect(page.getByText('更新したご案内', { exact: true })).toHaveCount(0);
  const reset = await storedData(page);
  expect(reset.members).toHaveLength(1);
  expect(reset.currentMemberId).toBeNull();
  expect(reset.members[0].stamps).toBe(9);
  expect(reset.notices).toHaveLength(2);
});

async function expectLayout(page: Page) {
  const measurements = await page.evaluate(() => {
    const root = document.documentElement;
    const controls = Array.from(document.querySelectorAll<HTMLElement>('[role="button"], [role="tab"], input, textarea'))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && getComputedStyle(node).visibility !== 'hidden';
      })
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { name: node.getAttribute('aria-label') ?? node.textContent?.slice(0, 60), width: rect.width, height: rect.height, left: rect.left, right: rect.right };
      });
    return { width: innerWidth, documentWidth: root.scrollWidth, controls };
  });
  expect(measurements.documentWidth, 'No horizontal document overflow').toBeLessThanOrEqual(measurements.width);
  for (const control of measurements.controls) {
    expect(control.left, `${control.name}: left edge remains visible`).toBeGreaterThanOrEqual(-1);
    expect(control.right, `${control.name}: right edge remains visible`).toBeLessThanOrEqual(measurements.width + 1);
    expect(control.height, `${control.name}: touch target height`).toBeGreaterThanOrEqual(48);
    expect(control.width, `${control.name}: touch target width`).toBeGreaterThanOrEqual(48);
  }
}

async function enlargeText(page: Page) {
  // A browser text-size stress check. This does not validate iOS Dynamic Type.
  await page.evaluate(() => {
    for (const node of Array.from(document.querySelectorAll<HTMLElement>('[dir="auto"]'))) {
      if (node.dataset.textSizeChecked) continue;
      const computed = getComputedStyle(node);
      const fontSize = Number.parseFloat(computed.fontSize);
      const lineHeight = Number.parseFloat(computed.lineHeight);
      node.style.fontSize = `${fontSize * 1.35}px`;
      if (Number.isFinite(lineHeight)) node.style.lineHeight = `${lineHeight * 1.35}px`;
      node.dataset.textSizeChecked = 'true';
    }
  });
}

async function expectHomeActionAboveNavigation(page: Page) {
  const action = await page.getByRole('button', { name: '会員証をひらく　→', exact: true }).boundingBox();
  const navigation = await page.getByRole('tab', { name: 'ホーム', exact: true }).boundingBox();
  expect(action).not.toBeNull();
  expect(navigation).not.toBeNull();
  expect(action!.y, 'Home membership action is in the initial viewport').toBeGreaterThanOrEqual(0);
  expect(action!.y + action!.height, 'Home membership action is fully above the bottom navigation').toBeLessThanOrEqual(navigation!.y);
}

test('customer and staff controls fit each viewport with 48px touch targets and larger browser text', async ({ page }) => {
  await showSample(page);
  for (const tab of ['ホーム', '会員証', '特典', 'お店']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    if (tab === 'お店') {
      await expect(page.getByText('東京都中野区本町4-30-14', { exact: true })).toBeVisible();
      await expect(page.getByText('03-3381-7012', { exact: true })).toBeVisible();
      await expect(page.getByText('10:00〜19:00（基本定休日：月曜日）', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '電話をかける', exact: true })).toBeVisible();
      await expect(page.getByText('玉屋のお菓子', { exact: true })).toHaveCount(0);
      for (const name of ['どら焼き', '鍋横最中', '長者もち', 'お赤飯']) {
        await expect(page.getByText(name, { exact: true })).toHaveCount(0);
      }
      await page.evaluate(() => {
        const state = window as unknown as { storeOriginalOpen: typeof window.open; storeOpenedUrl?: string };
        state.storeOriginalOpen = window.open;
        window.open = ((url) => { state.storeOpenedUrl = String(url); return null; }) as typeof window.open;
      });
      try {
        await page.getByRole('button', { name: '地図で見る　↗', exact: true }).click();
        const value = await page.evaluate(() => (window as unknown as { storeOpenedUrl?: string }).storeOpenedUrl);
        const map = new URL(value!);
        expect(map.origin).toBe('https://www.google.com');
        expect(map.searchParams.get('query')).toBe('東京都中野区本町4-30-14');
      } finally {
        await page.evaluate(() => { window.open = (window as unknown as { storeOriginalOpen: typeof window.open }).storeOriginalOpen; });
      }
    }
    await expectLayout(page);
    if (tab === 'ホーム') await expectHomeActionAboveNavigation(page);
    await enlargeText(page);
    await expectLayout(page);
    if (tab === 'ホーム') await expectHomeActionAboveNavigation(page);
  }
  await showStaff(page);
  await expectLayout(page);
  await enlargeText(page);
  await expectLayout(page);
  await page.getByRole('button', { name: 'カメラで会員QRを読み取る', exact: true }).click();
  await expect(page.getByText('カメラ読み取りについて', { exact: true })).toBeVisible();
  await expectLayout(page);
});
