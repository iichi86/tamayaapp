export const shop = {
  name: 'むさしの玉屋',
  area: '東京都中野区・新中野駅周辺',
  address: null as string | null,
  phone: null as string | null,
  hours: null as string | null,
  colors: {
    cream: '#F5F2E9', white: '#FFFFFF', ink: '#292F2B', green: '#234C3A',
    muted: '#697268', line: '#DADFD5', pale: '#E8EEE6', gold: '#92753E',
  },
  products: [
    { id: 'dorayaki', name: 'どら焼き', motif: '〇', description: null, price: null },
    { id: 'monaka', name: '鍋横最中', motif: '◇', description: null, price: null },
    { id: 'mochi', name: '長者もち', motif: '◯', description: null, price: null },
    { id: 'sekihan', name: 'お赤飯', motif: '▦', description: null, price: null },
  ],
  reward: { stampsRequired: 10, discountYen: 100, validityDays: 30, dailyLimit: 1 },
} as const;
