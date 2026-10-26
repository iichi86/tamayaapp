import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('管理画面で登録・2画面への反映・特典使用・お知らせ・スタッフ停止を確認する', async ({ page, browser }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/');
  await expect(page.locator('#stats')).toContainText('会員数');
  await page.locator('#session').selectOption('demo-new-customer');
  await page.locator('#nickname').fill('サーバー確認');
  await page.getByRole('button', { name: '会員登録する', exact: true }).click();
  await expect(page.locator('#customer-member')).toContainText('サーバー確認さん');
  await expect(page.locator('#customer-member .balance')).toContainText('0');

  const customerContext = await browser.newContext();
  const customer = await customerContext.newPage();
  await customer.goto('/');
  await expect(customer.locator('#stats')).toContainText('会員数');
  await customer.locator('#session').selectOption('demo-customer');
  await expect(customer.locator('#customer-member .balance')).toContainText('9');

  await page.locator('#session').selectOption('demo-owner');
  await page.locator('#members').getByRole('button', { name: /体験用の会員さん/ }).click();
  await page.getByRole('button', { name: 'スタンプ付与を確認する', exact: true }).click();
  await expect(page.locator('#message')).toContainText('クーポンを1枚発行');
  await expect(page.locator('#target-member .balance')).toContainText('0');
  await customer.getByRole('button', { name: '最新の状態を取得', exact: true }).click();
  await expect(customer.locator('#customer-member .balance')).toContainText('0');
  await expect(customer.locator('#customer-member .chip', { hasText: '未使用' })).toHaveCount(1);
  await page.getByRole('button', { name: 'スタンプ付与を確認する', exact: true }).click();
  await expect(page.locator('#error')).toContainText('本日は付与済み');
  await page.getByRole('button', { name: '特典利用を確認する', exact: true }).click();
  await expect(page.locator('#message')).toContainText('使用済み');
  await customer.getByRole('button', { name: '最新の状態を取得', exact: true }).click();
  await expect(customer.locator('#customer-member .chip', { hasText: '使用済み' })).toHaveCount(2);
  await expect(customer.locator('#customer-member .chip', { hasText: '期限切れ' })).toHaveCount(1);

  await page.locator('#notice-title').fill('管理サーバーのお知らせ');
  await page.locator('#notice-body').fill('別の画面でも同じ保存内容を確認できます。');
  await page.getByRole('button', { name: 'お知らせを保存する', exact: true }).click();
  await expect(page.locator('#message')).toContainText('お知らせを保存');
  await customer.getByRole('button', { name: '最新の状態を取得', exact: true }).click();
  await expect(customer.locator('#notices')).toContainText('管理サーバーのお知らせ');
  await page.getByRole('button', { name: 'このスタッフを停止する', exact: true }).click();
  await expect(page.locator('#message')).toContainText('停止しました');
  await customer.locator('#session').selectOption('demo-staff');
  await expect(customer.locator('#error')).toContainText('スタッフ権限');
  await page.getByRole('button', { name: 'このスタッフを再開する', exact: true }).click();
  await expect(page.locator('#message')).toContainText('再開しました');
  await page.reload();
  await expect(page.locator('#members')).toContainText('サーバー確認さん');
  await page.locator('#members').getByRole('button', { name: /体験用の会員さん/ }).click();
  await expect(page.locator('#target-member .balance')).toContainText('0');
  const directory = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
  mkdirSync(directory, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${directory}/management.png`, fullPage: false });
  await customerContext.close();
});

test('幅390・320pxと大きな文字でも横にはみ出さずボタンを押せる', async ({ page }) => {
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await expect(page.locator('#stats')).toContainText('会員数');
    await page.locator('#members').getByRole('button', { name: /体験用の会員さん/ }).click();
    await page.addStyleTag({ content: 'body { font-size: 23px !important; }' });
    const checks = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth <= window.innerWidth,
      buttons: [...document.querySelectorAll('button')].filter(button => button.getClientRects().length > 0)
        .every(button => button.getBoundingClientRect().height >= 48),
    }));
    expect(checks).toEqual({ width: true, buttons: true });
  }
});
