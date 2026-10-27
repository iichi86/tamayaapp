import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator, AppState, Linking, Modal, Pressable, RefreshControl, ScrollView,
  StyleSheet, Text, TextInput, View, useWindowDimensions,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import QRCode from 'react-native-qrcode-svg';
import type {
  AccountSnapshot, MemberPresentation, ServerCoupon, ServerMember, ServerNotice, StoreInfo,
} from '../../shared/contracts';
import { Button, Card, Heading, Muted, Tag, styles, theme } from '../ui';
import type { AuthPort, ProductionApi } from './ports';
import { ProductionStaffScreen } from './ProductionStaffScreen';

const tabs = ['ホーム', '会員証', '特典', 'お店'] as const;
type Tab = typeof tabs[number];
type LegalPage = 'terms' | 'privacy' | 'support';
const labels = { available: '未使用', used: '使用済み', expired: '期限切れ' };
const date = (value: string) => new Date(value).toLocaleString('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
function errorText(error: unknown) {
  return error instanceof Error ? error.message : '通信できませんでした。インターネットへの接続を確認し、もう一度お試しください。';
}
function isUnauthorized(error: unknown) {
  const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 0;
  return [401, 403, 410].includes(status);
}
function Field({ label, value, onChange, secure = false, email = false, editable = true, maxLength = 254 }: {
  label: string; value: string; onChange: (value: string) => void; secure?: boolean; email?: boolean; editable?: boolean; maxLength?: number;
}) {
  return <View style={s.field}>
    <Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} editable={editable}
      style={styles.input} secureTextEntry={secure} autoCapitalize={email || secure ? 'none' : 'sentences'}
      autoCorrect={!email && !secure} keyboardType={email ? 'email-address' : 'default'}
      textContentType={email ? 'emailAddress' : secure ? 'password' : 'nickname'} maxLength={maxLength} />
  </View>;
}
function Consent({ checked, onChange, onLegal }: { checked: boolean; onChange: (value: boolean) => void; onLegal: (page: LegalPage) => void }) {
  return <View style={{ gap: 10 }}>
    <Button label="利用規約を読む" variant="ghost" onPress={() => onLegal('terms')} />
    <Button label="プライバシーポリシーを読む" variant="ghost" onPress={() => onLegal('privacy')} />
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }}
      accessibilityLabel="利用規約とプライバシーポリシーに同意する" onPress={() => onChange(!checked)} style={s.checkRow}>
      <View style={[s.check, checked && { backgroundColor: theme.green }]}><Text style={s.checkText}>{checked ? '✓' : ''}</Text></View>
      <Text style={[styles.body, { flex: 1 }]}>利用規約とプライバシーポリシーを確認し、同意します</Text>
    </Pressable>
  </View>;
}
function Progress({ member, store }: { member: ServerMember; store: StoreInfo }) {
  const required = store.reward.stampsRequired;
  return <View style={{ gap: 18 }}>
    <View style={s.progressRow}>
      <View><Text style={styles.label}>ご来店スタンプ</Text><Text style={s.count}>{member.stamps}<Text style={s.unit}> / {required} 個</Text></Text></View>
      <View><Muted>次の特典まで</Muted><Text style={s.remaining}>あと {Math.max(0, required - member.stamps)} 個</Text></View>
    </View>
    <View accessible accessibilityLabel={`スタンプ${required}個中${member.stamps}個`} style={s.stamps}>
      {Array.from({ length: Math.min(required, 30) }, (_, index) => <View key={index} accessible={false}
        style={[s.stamp, index < member.stamps && { backgroundColor: theme.green, borderColor: theme.green }]}>
        <Text accessible={false} style={[s.stampText, index < member.stamps && { color: theme.white }]}>{index < member.stamps ? '玉' : String(index + 1)}</Text>
      </View>)}
    </View>
  </View>;
}
function RuleNote({ store }: { store: StoreInfo }) {
  const policy = store.reward;
  return <View style={s.rule}>
    <Text style={styles.label}>ご来店特典について</Text>
    <Muted>ご来店1回につき1スタンプ。同じ日の付与は日本時間で1回までです。</Muted>
    {policy.minimumPurchaseYen > 0 && <Muted>1回のお会計が{policy.minimumPurchaseYen.toLocaleString('ja-JP')}円以上の場合に、スタンプの対象となります。</Muted>}
    <Muted>{policy.stampsRequired}個で{policy.benefit?.label ?? 'ご来店特典'}を発行し、{policy.stampsRequired}個を消費します。有効期間は発行から{policy.validityDays}日間です。</Muted>
    {policy.redemptionMinimumPurchaseYen > 0 ? <Muted>特典の利用には、1回のお会計が{policy.redemptionMinimumPurchaseYen.toLocaleString('ja-JP')}円以上必要です。</Muted>
      : <Muted>特典の交換時に追加の購入は必要ありません。</Muted>}
    <Muted>スタンプ対象商品：{(policy.stampEligibleProducts ?? policy.eligibleProducts).join('・')}</Muted>
    <Muted>特典で交換できる商品：{policy.eligibleProducts.join('・')}</Muted>
    {policy.combinationRule && <Muted>併用条件：{policy.combinationRule}</Muted>}
    {!policy.operationsEnabled && <Text style={s.warning}>特典内容の確認中のため、スタンプ付与と特典利用は開始していません。</Text>}
    <Muted>スタンプ付与・特典の使用は店頭スタッフが確認して行います。</Muted>
  </View>;
}
function Notices({ notices }: { notices: ServerNotice[] }) {
  return <Card><Heading>お知らせ</Heading>{notices.length ? notices.map((notice) => <View key={notice.id} style={s.listItem}>
    <Text style={styles.label}>{notice.title}</Text><Muted>{notice.body}</Muted><Muted>{date(notice.updatedAt)}</Muted>
  </View>) : <Muted>現在、新しいお知らせはありません。</Muted>}</Card>;
}
function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <View style={s.overlay}><SafeAreaView style={s.sheet}>
      <ScrollView contentContainerStyle={{ gap: 18, padding: 22 }} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        <Heading>{title}</Heading>{children}<Button label="閉じる" variant="secondary" onPress={onClose} />
      </ScrollView>
    </SafeAreaView></View>
  </Modal>;
}

function Authentication({ auth, busy, run, onLegal }: {
  auth: AuthPort; busy: boolean; run: (operation: () => Promise<unknown>, success?: string) => Promise<void>; onLegal: (page: LegalPage) => void;
}) {
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  return <Card>
    <Heading>{mode === 'signup' ? '会員登録をはじめる' : mode === 'reset' ? 'パスワードを再設定' : '会員ログイン'}</Heading>
    <Muted>{mode === 'signup' ? 'メールアドレスで登録します。メールの確認後にニックネームを登録すると、会員証を使えます。' : mode === 'reset' ? '登録したメールアドレスを入力してください。再設定の案内を送信します。' : '機種変更した場合も、同じメールアドレスとパスワードで会員証を引き継げます。'}</Muted>
    <Field label="メールアドレス" email value={email} onChange={setEmail} editable={!busy} />
    {mode !== 'reset' && <Field label="パスワード" secure value={password} onChange={setPassword} editable={!busy} maxLength={128} />}
    {mode === 'signup' && <><Muted>パスワードは12文字以上で設定してください。</Muted><Consent checked={agreed} onChange={setAgreed} onLegal={onLegal} /></>}
    <Button label={mode === 'signup' ? '確認メールを送って登録する' : mode === 'reset' ? '再設定メールを送る' : 'ログインする'}
      disabled={busy || !email.trim() || (mode !== 'reset' && !password) || (mode === 'signup' && (!agreed || password.length < 12))}
      loading={busy} onPress={() => {
        if (mode === 'reset') void run(() => auth.resetPassword(email.trim()), '該当するアカウントがある場合は、再設定メールを送信します。受信箱と迷惑メールをご確認ください。');
        else if (mode === 'signup') void run(async () => { await auth.signUp(email.trim(), password); await auth.sendVerification(); setPassword(''); }, '確認メールを送信しました。メール内のリンクを開いてから、このアプリに戻ってください。');
        else void run(async () => { await auth.signIn(email.trim(), password); setPassword(''); });
      }} />
    {mode === 'login' ? <><Button label="はじめての方：会員登録" variant="secondary" disabled={busy} onPress={() => setMode('signup')} /><Button label="パスワードを忘れた方" variant="ghost" disabled={busy} onPress={() => setMode('reset')} /></>
      : <Button label="ログイン画面に戻る" variant="secondary" disabled={busy} onPress={() => setMode('login')} />}
  </Card>;
}

export function ProductionApp({ api, auth }: { api: ProductionApi; auth: AuthPort }) {
  return <SafeAreaProvider><Main api={api} auth={auth} /></SafeAreaProvider>;
}
function Main({ api, auth }: { api: ProductionApi; auth: AuthPort }) {
  const session = useSyncExternalStore(auth.subscribe, auth.getSnapshot, auth.getSnapshot);
  const [store, setStore] = useState<StoreInfo | null>(null);
  const [notices, setNotices] = useState<ServerNotice[]>([]);
  const [accountRecord, setAccountRecord] = useState<{ uid: string; data: AccountSnapshot } | null>(null);
  const [tab, setTab] = useState<Tab>('ホーム');
  const [staffMode, setStaffMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [legal, setLegal] = useState<LegalPage | null>(null);
  const [couponId, setCouponId] = useState<string | null>(null);
  const [nickname, setNickname] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [qr, setQr] = useState<MemberPresentation | null>(null);
  const [qrFailure, setQrFailure] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [appActive, setAppActive] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const requestVersion = useRef(0);
  const actionLock = useRef(false);
  const qrVersion = useRef(0);
  const user = session.user;
  // A changed Firebase session must never render another account's cached data, even for one frame.
  const account = user?.uid === accountRecord?.uid ? accountRecord?.data ?? null : null;
  const member = account?.member ?? null;
  const coupon = member?.coupons.find((item) => item.id === couponId) ?? null;
  const { width } = useWindowDimensions();

  useEffect(() => { setAgreed(false); }, [store?.legal.termsVersion, store?.legal.privacyVersion]);

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    const identityKey = user?.uid ?? null;
    const isCurrent = () => version === requestVersion.current && (auth.getSnapshot().user?.uid ?? null) === identityKey;
    setRefreshing(true);
    try {
      const [nextStore, nextNotices] = await Promise.all([api.store(), api.notices()]);
      if (!isCurrent()) return;
      setStore(nextStore); setNotices(nextNotices);
      const nextAccount = user?.emailVerified ? await api.me() : null;
      if (!isCurrent()) return;
      setAccountRecord(nextAccount && identityKey ? { uid: identityKey, data: nextAccount } : null); setFailure(null);
      if (!nextAccount?.staff?.active) setStaffMode(false);
    } catch (error) {
      if (isCurrent()) {
        setFailure(errorText(error)); setQr(null);
        if (isUnauthorized(error)) { setAccountRecord(null); setStaffMode(false); setCouponId(null); }
      }
    } finally {
      if (isCurrent()) { setRefreshing(false); setLoading(false); }
    }
  }, [api, auth, user?.uid, user?.emailVerified]);
  useEffect(() => {
    setAccountRecord(null); setQr(null); setCouponId(null); setStaffMode(false); setMenu(false);
    setDeleting(false); setDeletePassword(''); setDeleteConfirmation('');
    setNickname(''); setAgreed(false); setLoading(true);
    void refresh();
    return () => { requestVersion.current++; qrVersion.current++; };
  }, [refresh]);
  useEffect(() => {
    if (couponId && !coupon) setCouponId(null);
  }, [couponId, coupon]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') { void auth.reloadUser().catch(() => {}); void refresh(); }
      else { qrVersion.current++; setQr(null); }
      setAppActive(state === 'active');
    });
    return () => listener.remove();
  }, [auth, refresh]);
  useEffect(() => {
    if (!appActive || !user?.emailVerified) return;
    // Another device may have awarded a stamp while this screen remains open.
    const timer = setInterval(() => { void refresh(); }, 30_000);
    return () => clearInterval(timer);
  }, [appActive, user?.emailVerified, refresh]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    setQr(null); setQrFailure(null);
    if (tab !== '会員証' || !member || staffMode || failure || !user?.emailVerified || !appActive) return;
    let active = true;
    async function updateQr() {
      const version = ++qrVersion.current;
      try {
        const presentation = await api.qr();
        if (active && version === qrVersion.current && auth.getSnapshot().user?.uid === user?.uid) { setQr(presentation); setQrFailure(null); }
      } catch (error) {
        if (active && version === qrVersion.current && auth.getSnapshot().user?.uid === user?.uid) {
          setQr(null); setQrFailure(errorText(error));
          if (isUnauthorized(error)) { setAccountRecord(null); setStaffMode(false); setCouponId(null); setFailure(errorText(error)); }
        }
      }
    }
    void updateQr();
    const timer = setInterval(() => { void updateQr(); }, 60_000);
    return () => { active = false; qrVersion.current++; clearInterval(timer); };
  }, [api, auth, tab, member?.id, staffMode, failure, user?.uid, user?.emailVerified, refreshing, appActive]);
  async function run(operation: () => Promise<unknown>, success?: string) {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(true);
    try { await operation(); if (success) setMessage(success); }
    catch (error) {
      if (isUnauthorized(error)) { setAccountRecord(null); setStaffMode(false); setCouponId(null); setQr(null); }
      setMessage(errorText(error));
    }
    finally { actionLock.current = false; setBusy(false); }
  }
  async function openLink(url: string) {
    try { await Linking.openURL(url); } catch { setMessage('リンクを開けませんでした。表示された情報をご確認ください。'); }
  }
  const requireLogin = () => { setTab('会員証'); setStaffMode(false); };
  const available = member?.coupons.filter((item) => item.status === 'available' && Date.parse(item.expiresAt) > now) ?? [];
  function registration() {
    if (session.loading) return <Card><ActivityIndicator color={theme.green} /><Muted>ログイン状態を確認しています</Muted></Card>;
    if (!user) return <Authentication auth={auth} busy={busy} run={run} onLegal={setLegal} />;
    if (!user.emailVerified) return <Card>
      <Heading>メールアドレスの確認</Heading><Text style={styles.body}>{user.email}</Text>
      <Muted>確認メール内のリンクを開き、この画面に戻って下のボタンを押してください。確認が完了すると、会員登録に進めます。</Muted>
      <Button label="メール確認後、会員登録へ進む" loading={busy} onPress={() => { void run(async () => { await auth.reloadUser(); await refresh(); }); }} />
      <Button label="確認メールを再送する" disabled={busy} variant="secondary" onPress={() => { void run(() => auth.sendVerification(), '確認メールを再送しました。受信箱と迷惑メールをご確認ください。'); }} />
      <Button label="別のアカウントでログインする" disabled={busy} variant="ghost" onPress={() => { void run(() => auth.signOut()); }} />
    </Card>;
    return <Card>
      <Heading>ニックネームを登録</Heading><Muted>お名前の代わりに、店頭でお呼びできるニックネームを登録してください。0スタンプから始まります。</Muted>
      <Field label="ニックネーム" value={nickname} onChange={setNickname} editable={!busy} maxLength={20} />
      <Consent checked={agreed} onChange={setAgreed} onLegal={setLegal} />
      <Button label="会員登録して会員証を表示" disabled={busy || !nickname.trim() || !agreed || !store} loading={busy} onPress={() => {
        void run(async () => {
          if (!store) return;
          await api.register({ nickname: nickname.trim(), acceptedTermsVersion: store.legal.termsVersion, acceptedPrivacyVersion: store.legal.privacyVersion });
          await refresh(); setTab('会員証');
        }, '会員登録が完了しました。');
      }} />
    </Card>;
  }
  function membership() {
    if (!member || !store) return registration();
    const qrIsCurrent = qr && Date.parse(qr.expiresAt) > now && !failure;
    return <>
      <Card>
        <Tag>店頭でご提示ください</Tag><Text style={s.memberName}>{member.nickname} さん</Text>
        <Text selectable style={styles.body}>会員番号 {member.number}</Text>
        <View style={s.qrBox}>
          {qrIsCurrent ? <QRCode value={qr.qr} size={Math.max(140, Math.min(width - 112, 240))} backgroundColor="#FFFFFF" color="#172A20" quietZone={8} />
            : <><Muted>{qrFailure ?? '会員QRを更新しています。通信状態をご確認ください。'}</Muted><Button label="会員証を更新" variant="secondary" onPress={() => { void refresh(); }} /></>}
        </View>
        <Muted>QRは短時間で更新されます。店頭スタッフが読み取り、来店を確認してからスタンプをお付けします。</Muted>
        <Muted>付与結果は自動更新します。すぐに確認する場合は、この画面を下に引いて更新してください。</Muted>
        <Progress member={member} store={store} />
      </Card>
      <Card><Heading>スタンプ履歴</Heading>{member.stampHistory.length ? member.stampHistory.map((stamp) => <View key={stamp.id} style={s.listItem}>
        <Text style={styles.body}>ご来店　＋1スタンプ</Text><Muted>{date(stamp.createdAt)}</Muted>
        {stamp.purchaseAmountYen > 0 && <Muted>確認したお会計 {stamp.purchaseAmountYen.toLocaleString('ja-JP')}円</Muted>}
      </View>) : <Muted>まだ付与履歴はありません。ご来店時に会員証をご提示ください。</Muted>}</Card>
      <RuleNote store={store} />
    </>;
  }
  function couponList() {
    if (!member) return <Card><Heading>特典を確認する</Heading><Muted>会員登録・ログイン後に、獲得した特典を確認できます。</Muted><Button label="会員証を開く" onPress={requireLogin} /></Card>;
    return <><Heading>お持ちの特典</Heading><Muted>使いたい特典を開き、店頭スタッフにご提示ください。</Muted>
      {!member.coupons.length && <Card><Heading>これからのお楽しみ</Heading><Muted>スタンプを集めると、ここに特典が届きます。</Muted><Button label="会員証を見る" variant="secondary" onPress={requireLogin} /></Card>}
      {member.coupons.map((item) => {
        const status = item.status === 'available' && Date.parse(item.expiresAt) <= now ? 'expired' : item.status;
        return <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${item.benefit.label}、${labels[status]}。詳細を開く`}
          onPress={() => setCouponId(item.id)} style={({ pressed }) => [s.couponCard, pressed && { opacity: .75 }]}>
          <Tag tone={status === 'available' ? 'green' : 'muted'}>{labels[status]}</Tag>
          <Text style={s.couponTitle}>{item.benefit.label}</Text><Muted>有効期限 {date(item.expiresAt)}</Muted><Text style={s.link}>詳細を開く →</Text>
        </Pressable>;
      })}
      {store && <RuleNote store={store} />}
    </>;
  }
  function shopPage() {
    if (!store) return null;
    return <><Card><Heading eyebrow={store.area}>{store.name}</Heading>
      {store.address ? <><Text style={styles.label}>住所</Text><Text selectable style={styles.body}>{store.address}</Text><Button label="地図で住所を開く" variant="secondary" onPress={() => { void openLink(`https://maps.apple.com/?q=${encodeURIComponent(`${store.name} ${store.address}`)}`); }} /></> : <Muted>住所は確認後に掲載します。</Muted>}
      {store.phone ? <><Text style={styles.label}>店舗の電話番号</Text><Text selectable style={styles.body}>{store.phone}</Text><Button label="店舗に電話する" variant="secondary" onPress={() => { if (store.phone) void openLink(`tel:${store.phone.replace(/[^+\d]/g, '')}`); }} /></> : <Muted>店舗の電話番号は確認後に掲載します。</Muted>}
      {store.hours && <><Text style={styles.label}>営業時間</Text><Text style={styles.body}>{store.hours}</Text></>}
    </Card><Card><Heading>玉屋のお菓子</Heading>{store.products.map((product) => <View key={product.id} style={s.listItem}><Text style={styles.body}>{product.name}</Text></View>)}</Card>
      <Notices notices={notices} /><RuleNote store={store} /><Card><Heading>アプリについて</Heading>
        <Muted>会員サービス運営者：{store.operator.name}</Muted><Muted>会員サービスのお問い合わせ：{store.operator.phone}</Muted>
        <Button label="お問い合わせ・機種変更のご案内" variant="secondary" onPress={() => setLegal('support')} />
        <Button label="利用規約" variant="ghost" onPress={() => setLegal('terms')} /><Button label="プライバシーポリシー" variant="ghost" onPress={() => setLegal('privacy')} />
      </Card></>;
  }
  const legalTitle = legal === 'terms' ? '利用規約' : legal === 'privacy' ? 'プライバシーポリシー' : 'お問い合わせ・会員の復旧';
  const couponStatus = coupon && coupon.status === 'available' && Date.parse(coupon.expiresAt) <= now ? 'expired' : coupon?.status;
  // Keep one native modal mounted so iOS does not have to present a second modal over the first.
  const activeSheet = message !== null ? 'message' : legal !== null ? 'legal' : deleting ? 'deletion' : coupon !== null ? 'coupon' : menu ? 'menu' : null;
  const sheetTitle = activeSheet === 'message' ? 'ご案内' : activeSheet === 'legal' ? legalTitle : activeSheet === 'deletion' ? '退会・アカウント削除' : activeSheet === 'coupon' ? '店頭でご提示ください' : 'アカウントと設定';
  function closeSheet() {
    if (busy) return;
    if (activeSheet === 'message') setMessage(null);
    else if (activeSheet === 'legal') setLegal(null);
    else if (activeSheet === 'deletion') { setDeleting(false); setDeletePassword(''); }
    else if (activeSheet === 'coupon') setCouponId(null);
    else setMenu(false);
  }
  return <SafeAreaView edges={['top', 'bottom']} style={s.safe}>
    <StatusBar style="dark" /><View style={s.app}>
      <View style={s.header}><View style={{ flex: 1, gap: 3 }}><Text style={s.brand}>{store?.name ?? 'むさしの玉屋'}</Text><Text style={s.subtitle}>{staffMode ? '店舗スタッフ' : '会員のひろば'}</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel="アカウントと設定を開く" onPress={() => { setMenu(true); setNickname(member?.nickname ?? ''); }} style={s.menuButton}><Text style={s.link}>設定</Text></Pressable>
      </View>
      {failure && <View style={s.failure} accessibilityRole="alert"><Text style={s.warning}>{failure}</Text><Button label="再読み込み" variant="secondary" onPress={() => { void refresh(); }} /></View>}
      {loading && !store ? <View style={s.loading}><ActivityIndicator color={theme.green} /><Muted>お店の情報を読み込んでいます</Muted>{failure && <Button label="もう一度読み込む" onPress={() => { void refresh(); }} />}</View>
        : staffMode && account?.staff?.active && store ? <ProductionStaffScreen api={api} store={store} staff={account.staff} onChanged={refresh} onBack={() => setStaffMode(false)} />
          : <ScrollView key={tab} style={{ flex: 1 }} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh(); }} tintColor={theme.green} />}>
            {tab === 'ホーム' && <>
              <View style={s.welcome}><Text style={s.welcomeText}>いつものお菓子に、{`\n`}小さなお楽しみを。</Text><Muted>{member ? `${member.nickname}さん、こんにちは。` : 'むさしの玉屋の会員サービスへようこそ。'}</Muted></View>
              {member && store ? <Card><Progress member={member} store={store} /><Button label="会員証をひらく" onPress={requireLogin} /></Card>
                : <Card><Heading>ご来店のたびに、ひとつ。</Heading><Muted>無料の会員登録で、来店スタンプと特典をご利用いただけます。</Muted><Button label="会員登録・ログイン" onPress={requireLogin} /></Card>}
              <Card><Heading>利用できる特典</Heading><Text style={s.remaining}>{available.length} 件</Text><Button label="特典を見る" variant="secondary" onPress={() => setTab('特典')} /></Card>
              <Notices notices={notices} />{store && <RuleNote store={store} />}
            </>}
            {tab === '会員証' && membership()}{tab === '特典' && couponList()}{tab === 'お店' && shopPage()}
          </ScrollView>}
      {!staffMode && <View style={s.tabs} accessibilityRole="tablist">{tabs.map((item, index) => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: item === tab }} accessibilityLabel={item}
        onPress={() => setTab(item)} style={[s.tab, item === tab && { backgroundColor: theme.pale }]}>
        <Text accessible={false} style={[s.tabSymbol, item === tab && { color: theme.green }]}>{['⌂', '▣', '◇', '玉'][index]}</Text><Text style={[s.tabLabel, item === tab && { color: theme.green, fontWeight: '700' }]}>{item}</Text>
      </Pressable>)}</View>}
    </View>
    <Sheet visible={activeSheet !== null} title={sheetTitle} onClose={closeSheet}>
      {activeSheet === 'menu' && <>
      {user ? <>
        <Text style={styles.body}>{user.email}</Text><Muted>{user.emailVerified ? 'メール確認済み' : 'メール未確認'}</Muted><Text selectable style={styles.muted}>ログインID（スタッフ権限の登録用）{`\n`}{user.uid}</Text>
        {member && <><Field label="ニックネームの変更" value={nickname} onChange={setNickname} editable={!busy} maxLength={20} /><Button label="ニックネームを保存" disabled={busy || !nickname.trim()} loading={busy} onPress={() => { void run(async () => { await api.updateNickname(nickname.trim()); await refresh(); }, 'ニックネームを変更しました。'); }} /></>}
        {account?.staff?.active && <Button label={staffMode ? 'お客さんの画面へ' : '店舗スタッフの画面へ'} disabled={busy} variant="secondary" onPress={() => { setStaffMode(!staffMode); setMenu(false); }} />}
        <Button label="ログアウトする" disabled={busy} variant="secondary" onPress={() => { void run(async () => { await auth.signOut(); setMenu(false); }); }} />
        <Button label="退会・アカウント削除" disabled={busy} variant="ghost" onPress={() => { setMenu(false); setDeletePassword(''); setDeleteConfirmation(''); setDeleting(true); }} />
      </> : <Button label="会員登録・ログインへ" onPress={() => { setMenu(false); requireLogin(); }} />}
      <Button label="最新の情報に更新" disabled={busy} variant="secondary" onPress={() => { void refresh(); setMenu(false); }} />
      <Button label="お問い合わせ・機種変更" variant="ghost" onPress={() => setLegal('support')} />
      <Button label="利用規約" variant="ghost" onPress={() => setLegal('terms')} /><Button label="プライバシーポリシー" variant="ghost" onPress={() => setLegal('privacy')} />
      </>}
      {activeSheet === 'legal' && <>
      <Text selectable style={styles.body}>{!store ? 'お店の情報を読み込んでから、もう一度お試しください。' : legal === 'terms' ? store.legal.termsText : legal === 'privacy' ? store.legal.privacyText : store.legal.supportText}</Text>
      {store && legal === 'support' && <><Text style={styles.label}>会員サービス運営者：{store.operator.name}</Text><Text selectable style={styles.body}>{store.operator.phone}</Text><Button label="会員サービスの窓口に電話する" variant="secondary" onPress={() => { void openLink(`tel:${store.operator.phone.replace(/[^+\d]/g, '')}`); }} /></>}
      </>}
      {activeSheet === 'coupon' && <>
      {coupon && couponStatus && <><Tag tone={couponStatus === 'available' ? 'green' : 'muted'}>{labels[couponStatus]}</Tag><Text style={s.couponTitle}>{coupon.benefit.label}</Text><Text selectable style={styles.body}>特典番号 {coupon.id}</Text>
        <Text style={styles.body}>有効期限 {date(coupon.expiresAt)}</Text><Muted>対象商品：{coupon.eligibleProducts.join('・')}</Muted><Muted>併用条件：{coupon.combinationRule}</Muted>
        {coupon.redemptionMinimumPurchaseYen > 0 ? <Muted>利用時のお会計条件：{coupon.redemptionMinimumPurchaseYen.toLocaleString('ja-JP')}円以上</Muted>
          : <Muted>特典の交換時に追加の購入は必要ありません。</Muted>}
        {couponStatus === 'available' ? <Muted>この画面をスタッフにお見せください。スタッフが会員と特典番号を照合し、使用済みにします。</Muted> : <Muted>この特典は利用できません。</Muted>}
        {coupon.usedAt && <Muted>使用日時 {date(coupon.usedAt)}</Muted>}
      </>}
      </>}
      {activeSheet === 'deletion' && <>
      <Text style={styles.body}>会員情報、スタンプ、特典を削除します。削除した情報は元に戻せません。</Text><Muted>店舗スタッフ・オーナーの権限がある場合は、オーナーによる権限解除を先に行ってください。</Muted>
      <Field label="本人確認のため現在のパスワード" secure value={deletePassword} onChange={setDeletePassword} editable={!busy} maxLength={128} />
      <Field label="確認のため「退会する」と入力" value={deleteConfirmation} onChange={setDeleteConfirmation} editable={!busy} maxLength={10} />
      <Button label="確認してアカウントを削除する" disabled={busy || !deletePassword || deleteConfirmation !== '退会する'} loading={busy} onPress={() => {
        void run(async () => {
          await auth.reauthenticate(deletePassword);
          const result = await api.deleteAccount();
          setDeletePassword(''); setDeleting(false); await auth.signOut();
          setMessage(result.status === 'completed' ? '退会とアカウント削除が完了しました。' : '削除の受付が完了しました。アカウントの利用を停止し、サーバーで削除を続けます。');
        });
      }} />
      </>}
      {activeSheet === 'message' && <Text accessibilityRole="alert" style={styles.body}>{message}</Text>}
    </Sheet>
  </SafeAreaView>;
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.cream }, app: { flex: 1, width: '100%', maxWidth: 600, alignSelf: 'center' },
  header: { flexDirection: 'row', gap: 12, paddingHorizontal: 22, paddingVertical: 13, borderBottomWidth: 1, borderColor: theme.line, alignItems: 'center' },
  brand: { fontSize: 20, lineHeight: 29, color: theme.ink, fontWeight: '600', flexShrink: 1 }, subtitle: { fontSize: 13, lineHeight: 20, color: theme.muted },
  menuButton: { minHeight: 48, minWidth: 48, padding: 9, alignItems: 'center', justifyContent: 'center' }, link: { fontSize: 16, lineHeight: 25, fontWeight: '600', color: theme.green },
  content: { padding: 20, paddingBottom: 34, gap: 21 }, loading: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 18, padding: 24 },
  welcome: { gap: 14, paddingVertical: 15 }, welcomeText: { fontSize: 27, lineHeight: 43, color: theme.ink, fontWeight: '600', letterSpacing: 1.4 },
  progressRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 16 }, count: { fontSize: 52, lineHeight: 68, color: theme.green, fontWeight: '600' },
  unit: { fontSize: 17, fontWeight: '400' }, remaining: { fontSize: 23, lineHeight: 35, color: theme.green, fontWeight: '600' },
  stamps: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, stamp: { minWidth: 42, minHeight: 42, padding: 7, borderRadius: 23, borderWidth: 1, borderColor: theme.line, alignItems: 'center', justifyContent: 'center' },
  stampText: { fontSize: 18, lineHeight: 27, color: theme.muted }, memberName: { fontSize: 25, lineHeight: 38, color: theme.ink, fontWeight: '600' },
  qrBox: { alignItems: 'center', gap: 12, backgroundColor: '#FFFFFF', paddingVertical: 16 }, rule: { gap: 9, padding: 18, backgroundColor: theme.pale, borderRadius: 14 },
  listItem: { gap: 7, borderTopWidth: 1, borderColor: theme.line, paddingTop: 15 }, couponCard: { minHeight: 130, borderRadius: 18, padding: 21, backgroundColor: theme.white, gap: 12, borderColor: theme.line, borderWidth: 1 },
  couponTitle: { fontSize: 25, lineHeight: 37, color: theme.green, fontWeight: '600' },
  field: { gap: 8 }, checkRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  check: { width: 28, height: 28, borderWidth: 1, borderColor: theme.green, borderRadius: 5, alignItems: 'center', justifyContent: 'center' }, checkText: { color: theme.white, fontWeight: '700', fontSize: 20 },
  overlay: { flex: 1, backgroundColor: '#182C21BB', justifyContent: 'center', alignItems: 'center', padding: 14 }, sheet: { backgroundColor: theme.cream, maxHeight: '92%', maxWidth: 520, width: '100%', borderRadius: 19, overflow: 'hidden' },
  tabs: { flexDirection: 'row', padding: 5, borderTopWidth: 1, borderColor: theme.line, backgroundColor: theme.white }, tab: { minHeight: 65, paddingVertical: 8, paddingHorizontal: 2, flex: 1, alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: 10 },
  tabSymbol: { fontSize: 23, lineHeight: 28, color: theme.muted }, tabLabel: { fontSize: 14, lineHeight: 22, color: theme.muted, textAlign: 'center' },
  failure: { padding: 15, gap: 10, backgroundColor: '#FFF4E6' }, warning: { fontSize: 15, lineHeight: 25, color: '#815120' },
});
