export const shop = {
  name: 'むさしの玉屋',
  area: '東京都中野区・新中野駅周辺',
  address: '東京都中野区本町4-30-14' as string | null,
  phone: '03-3381-7012' as string | null,
  hours: '10:00〜19:00（基本定休日：月曜日）' as string | null,
  informationSource: '店舗関係者からの提供情報（2026年10月31日）',
  colors: {
    cream: '#F5F2E9', white: '#FFFFFF', ink: '#292F2B', green: '#234C3A',
    muted: '#697268', line: '#DADFD5', pale: '#E8EEE6', gold: '#92753E',
  },
  products: [] as { id: string; name: string; motif: string; description: string | null; price: number | null }[],
  reward: { stampsRequired: 10, discountYen: 100, validityDays: 30, dailyLimit: 1 },
} as const;
