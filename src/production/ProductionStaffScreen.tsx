import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal, Platform, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type {
  AuditRecord, MemberSummary, ServerMember, ServerNotice, StaffAccount,
  StaffRole, StoreInfo, StoreStats,
} from '../../shared/contracts';
import { Scanner } from '../screens/Scanner';
import { Button, Card, Heading, Muted, Tag, styles, theme } from '../ui';
import type { ProductionApi } from './ports';

interface Props {
  api: ProductionApi;
  store: StoreInfo;
  staff: StaffAccount;
  onChanged: () => Promise<void>;
  onBack: () => void;
  onError?: (message: string) => void;
}

type Confirmation =
  | { kind: 'stamp'; memberId: string; nickname: string; purchaseAmountYen: number }
  | { kind: 'coupon'; couponId: string; nickname: string; label: string; purchaseAmountYen: number }
  | { kind: 'staff'; uid: string; role: StaffRole; active: boolean };

function dateTime(value: string): string {
  return new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

/** Customer data and all role decisions come from authenticated server responses. */
export function ProductionStaffScreen({ api, store, staff, onChanged, onBack, onError }: Props) {
  const [stats, setStats] = useState<StoreStats | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemberSummary[]>([]);
  const [searched, setSearched] = useState(false);
  const [member, setMember] = useState<ServerMember | null>(null);
  const [purchaseAmount, setPurchaseAmount] = useState('');
  const [redemptionAmounts, setRedemptionAmounts] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<ServerNotice[]>([]);
  const [accounts, setAccounts] = useState<StaffAccount[]>([]);
  const [audit, setAudit] = useState<AuditRecord[]>([]);
  const [scanner, setScanner] = useState(false);
  const [editing, setEditing] = useState<{ id?: string; title: string; body: string } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [newUid, setNewUid] = useState('');
  const [newRole, setNewRole] = useState<StaffRole>('staff');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [permissionLost, setPermissionLost] = useState(false);
  const lock = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    setPurchaseAmount('');
    setRedemptionAmounts({});
  }, [member?.id]);

  const reportError = useCallback((cause: unknown) => {
    const text = cause instanceof Error ? cause.message : '操作を完了できませんでした。通信を確認して、もう一度お試しください。';
    if (!alive.current) return;
    setError(text);
    if (typeof cause === 'object' && cause !== null) {
      const code = 'code' in cause ? String(cause.code) : '';
      const status = 'status' in cause ? Number(cause.status) : 0;
      if (status === 401 || status === 403 || ['FORBIDDEN', 'STAFF_REQUIRED', 'OWNER_REQUIRED', 'UNAUTHENTICATED'].includes(code)) {
        setPermissionLost(true);
        setMember(null);
        setResults([]);
        setAccounts([]);
        setAudit([]);
        setNotices([]);
        setStats(null);
        setConfirmation(null);
        setEditing(null);
        setScanner(false);
      }
    }
    onError?.(text);
  }, [onError]);

  const refresh = useCallback(async () => {
    const [nextStats, nextNotices] = await Promise.all([api.stats(), api.notices()]);
    if (!alive.current) return;
    setStats(nextStats);
    setNotices(nextNotices);
    if (staff.role === 'owner') {
      const [nextAccounts, nextAudit] = await Promise.all([api.staffAccounts(), api.audit()]);
      if (!alive.current) return;
      setAccounts(nextAccounts);
      setAudit(nextAudit);
    }
  }, [api, staff.role]);

  async function run(operation: () => Promise<void>) {
    if (lock.current || permissionLost) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await operation();
    } catch (cause) {
      reportError(cause);
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }

  useEffect(() => {
    void refresh().catch(reportError);
  }, [refresh, reportError]);

  async function search() {
    const value = query.trim();
    if (!value) return;
    await run(async () => {
      const found = await api.staffMembers(value);
      if (!alive.current) return;
      setMember(null);
      setResults(found);
      setSearched(true);
    });
  }

  async function resolve(raw: string) {
    setScanner(false);
    await run(async () => {
      const found = await api.resolveQr(raw);
      if (!alive.current) return;
      setMember(found);
      setResults([]);
      setSearched(false);
      setMessage('会員証を確認しました。会員のお名前・番号を照合してから操作してください。');
    });
  }

  async function confirm() {
    const action = confirmation;
    if (!action) return;
    await run(async () => {
      // The API client preserves the request ID on uncertain network outcomes.
      if (action.kind === 'stamp') {
        const result = await api.grantStamp(action.memberId, action.purchaseAmountYen);
        if (!alive.current) return;
        setMember(result.member);
        setMessage(result.coupon ? '1スタンプを付与し、特典を1枚発行しました。' : '1スタンプを付与しました。');
      } else if (action.kind === 'coupon') {
        const result = await api.redeemCoupon(action.couponId, action.purchaseAmountYen);
        if (!alive.current) return;
        setMember(result.member);
        setMessage('特典を使用済みにしました。');
      } else {
        await api.setStaffAccount(action.uid, { role: action.role, active: action.active });
        if (!alive.current) return;
        setNewUid('');
        setMessage(action.active ? 'スタッフ権限を保存しました。' : 'スタッフ権限を停止しました。');
      }
      setConfirmation(null);
      await refresh();
      await onChanged();
    });
  }

  const disabled = busy || permissionLost;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const stampedToday = member?.stampHistory.some((stamp) => stamp.japanDate === today);
  const stampPurchase = Number(purchaseAmount);
  const validStampPurchase = purchaseAmount.length > 0 && Number.isSafeInteger(stampPurchase)
    && stampPurchase >= store.reward.minimumPurchaseYen && stampPurchase <= 100_000_000;

  return (
    <ScrollView
      contentContainerStyle={s.content}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <View style={s.header}>
        <Heading eyebrow={staff.role === 'owner' ? 'オーナー' : 'スタッフ'}>お店の管理</Heading>
        <Button label="お客さんの画面へ" variant="secondary" onPress={onBack} disabled={busy} />
      </View>
      <Muted>店舗で確認した操作だけを行ってください。スタンプ・特典・権限はサーバーで確認して保存します。</Muted>
      {error && <View accessibilityRole="alert" style={s.errorBox}><Text style={styles.error}>{error}</Text></View>}
      {message && <View accessibilityRole="alert" style={s.messageBox}><Text style={styles.body}>{message}</Text></View>}
      {permissionLost ? (
        <Card>
          <Heading>権限を確認してください</Heading>
          <Muted>ログインの有効期限またはスタッフ権限を確認できません。お客さんの画面へ戻り、ログインし直してください。</Muted>
          <Button label="お客さんの画面へ戻る" onPress={onBack} />
        </Card>
      ) : (
        <>
          <View style={s.metrics}>
            {[
              ['会員数', stats?.members], ['本日の付与', stats?.stampsToday], ['本日の特典利用', stats?.redemptionsToday],
            ].map(([label, value]) => (
              <View style={s.metric} key={String(label)}>
                <Text style={s.metricValue}>{value ?? '—'}</Text>
                <Text style={s.metricLabel}>{label}</Text>
              </View>
            ))}
          </View>
          <Muted>「本日」は日本時間です。件数は保存された利用記録から集計します。</Muted>
          <Button label="最新の情報に更新" variant="ghost" disabled={disabled} loading={busy} onPress={() => {
            void run(async () => {
              await refresh();
              if (member) setMember(await api.staffMember(member.id));
              await onChanged();
            });
          }} />
          {!store.reward.operationsEnabled && (
            <Card>
              <Tag tone="gold">特典条件の確認待ち</Tag>
              <Muted>正式な特典内容・併用条件の設定が完了するまで、スタンプ付与と特典利用を停止しています。</Muted>
            </Card>
          )}
          <Card>
            <Heading>会員を確認する</Heading>
            <Button label="会員QRコードを読み取る" onPress={() => setScanner(true)} disabled={disabled} />
            {scanner && (Platform.OS === 'web' ? (
              <View style={s.section}>
                <Muted>このブラウザ画面ではカメラを起動しません。iPhoneアプリで読み取るか、下の会員番号・ニックネーム検索をお使いください。</Muted>
                <Button label="読み取りの説明を閉じる" variant="secondary" onPress={() => setScanner(false)} />
              </View>
            ) : <Scanner onScan={(raw) => { void resolve(raw); }} onClose={() => setScanner(false)} />)}
            <Text style={styles.label}>会員番号 または ニックネーム</Text>
            <TextInput
              accessibilityLabel="会員番号またはニックネーム"
              value={query}
              onChangeText={setQuery}
              editable={!disabled}
              maxLength={80}
              style={styles.input}
              returnKeyType="search"
              onSubmitEditing={() => { void search(); }}
              placeholder="例：お客さんの会員番号"
            />
            <Button label="会員を検索する" variant="secondary" disabled={disabled || !query.trim()} onPress={() => { void search(); }} />
            <Muted>会員番号は完全一致、ニックネームは入力した文字で検索します。検索結果だけでは付与されません。</Muted>
            {searched && results.length === 0 && <Muted>該当する会員が見つかりません。入力内容をご確認ください。</Muted>}
            {results.map((result) => (
              <View key={result.id} style={s.section}>
                <Text style={s.subheading}>{result.nickname}さん</Text>
                <Muted>会員番号 {result.number}</Muted>
                <Button label={`${result.nickname}さんの会員情報を開く`} variant="secondary" disabled={disabled} onPress={() => {
                  void run(async () => { setMember(await api.staffMember(result.id)); setConfirmation(null); });
                }} />
              </View>
            ))}
          </Card>
          {member && (
            <Card>
              <Tag>確認対象の会員</Tag>
              <Text style={s.memberName}>{member.nickname}さん</Text>
              <Text selectable style={styles.body}>会員番号 {member.number}</Text>
              <Text style={s.balance}>{member.stamps} スタンプ</Text>
              <Muted>{store.reward.minimumPurchaseYen.toLocaleString('ja-JP')}円以上のお会計のある来店1回につき1スタンプ、日本時間で1日1回まで。{store.reward.stampsRequired}スタンプを使って特典を1枚発行します。</Muted>
              <Text style={styles.label}>今回のお会計金額（円）</Text>
              <TextInput
                accessibilityLabel="今回のお会計金額（円）"
                value={purchaseAmount}
                onChangeText={(value) => setPurchaseAmount(value.replace(/[^0-9]/g, ''))}
                keyboardType="number-pad"
                inputMode="numeric"
                editable={!disabled && !stampedToday}
                maxLength={9}
                style={styles.input}
                placeholder="実際のお会計金額を入力"
              />
              <Muted>レジのお会計を確認して入力してください。金額はレジと自動連携していません。</Muted>
              {purchaseAmount.length > 0 && !validStampPurchase && <Text style={styles.error}>スタンプ付与は{store.reward.minimumPurchaseYen.toLocaleString('ja-JP')}円以上のお会計が対象です。金額をご確認ください。</Text>}
              <Button
                label={stampedToday ? '本日は付与済みです' : 'スタンプ付与の確認へ'}
                disabled={disabled || stampedToday || !validStampPurchase || !store.reward.operationsEnabled}
                onPress={() => setConfirmation({ kind: 'stamp', memberId: member.id, nickname: member.nickname, purchaseAmountYen: stampPurchase })}
              />
              <Text style={s.subheading}>この会員の特典</Text>
              {member.coupons.length === 0 && <Muted>特典はまだありません。</Muted>}
              {member.coupons.map((coupon) => (
                <View key={coupon.id} style={s.section}>
                  <Text style={s.subheading}>{coupon.benefit.label}</Text>
                  <Tag tone={coupon.status === 'available' ? 'green' : 'muted'}>
                    {coupon.status === 'available' ? '未使用' : coupon.status === 'used' ? '使用済み' : '期限切れ'}
                  </Tag>
                  <Text selectable style={styles.muted}>特典番号 {coupon.id}</Text>
                  <Muted>有効期限 {dateTime(coupon.expiresAt)}</Muted>
                  <Muted>対象：{coupon.eligibleProducts.join('・')}</Muted>
                  <Muted>併用条件：{coupon.combinationRule}</Muted>
                  {coupon.redemptionMinimumPurchaseYen > 0 && <>
                    <Text style={styles.label}>特典利用時のお会計金額（円）</Text>
                    <TextInput
                      accessibilityLabel="特典利用時のお会計金額（円）"
                      value={redemptionAmounts[coupon.id] ?? ''}
                      onChangeText={(value) => setRedemptionAmounts((current) => ({ ...current, [coupon.id]: value.replace(/[^0-9]/g, '') }))}
                      keyboardType="number-pad"
                      inputMode="numeric"
                      editable={!disabled && coupon.status === 'available'}
                      maxLength={9}
                      style={styles.input}
                      placeholder="実際のお会計金額を入力"
                    />
                    <Muted>この特典は{coupon.redemptionMinimumPurchaseYen.toLocaleString('ja-JP')}円以上のお会計が対象です。レジのお会計を確認してください。</Muted>
                  </>}
                  <Button
                    label={coupon.status === 'available' ? '特典利用の確認へ' : 'この特典は利用できません'}
                    variant="secondary"
                    disabled={disabled || coupon.status !== 'available' || !store.reward.operationsEnabled
                      || (coupon.redemptionMinimumPurchaseYen > 0 && (!redemptionAmounts[coupon.id]
                        || Number(redemptionAmounts[coupon.id]) < coupon.redemptionMinimumPurchaseYen
                        || Number(redemptionAmounts[coupon.id]) > 100_000_000))}
                    onPress={() => setConfirmation({ kind: 'coupon', couponId: coupon.id, nickname: member.nickname, label: coupon.benefit.label,
                      purchaseAmountYen: coupon.redemptionMinimumPurchaseYen > 0 ? Number(redemptionAmounts[coupon.id]) : 0 })}
                  />
                </View>
              ))}
            </Card>
          )}
          <Card>
            <Heading>お知らせ</Heading>
            <Button label="お知らせを追加" variant="secondary" disabled={disabled} onPress={() => setEditing({ title: '', body: '' })} />
            {notices.length === 0 && <Muted>公開中のお知らせはありません。</Muted>}
            {notices.map((notice) => (
              <View key={notice.id} style={s.section}>
                <Text style={s.subheading}>{notice.title}</Text>
                <Text style={styles.body}>{notice.body}</Text>
                <Muted>更新 {dateTime(notice.updatedAt)}</Muted>
                <Button label={`「${notice.title}」を編集`} variant="ghost" disabled={disabled} onPress={() => setEditing({ id: notice.id, title: notice.title, body: notice.body })} />
              </View>
            ))}
          </Card>
          {staff.role === 'owner' && (
            <>
              <Card>
                <Heading>スタッフ権限の管理</Heading>
                <Muted>追加する人が同じアプリで登録・メール確認を済ませた後、アカウント画面に表示される本人のUIDを入力してください。操作履歴が残ります。</Muted>
                <Text style={styles.label}>追加するスタッフのUID</Text>
                <TextInput
                  accessibilityLabel="追加するスタッフのUID"
                  value={newUid}
                  onChangeText={setNewUid}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!disabled}
                  maxLength={128}
                  style={styles.input}
                />
                <Text style={styles.label}>付与する権限</Text>
                <View style={s.roleChoices}>
                  <Button label={newRole === 'staff' ? 'スタッフ ✓' : 'スタッフ'} variant={newRole === 'staff' ? 'primary' : 'secondary'} disabled={disabled} onPress={() => setNewRole('staff')} />
                  <Button label={newRole === 'owner' ? 'オーナー ✓' : 'オーナー'} variant={newRole === 'owner' ? 'primary' : 'secondary'} disabled={disabled} onPress={() => setNewRole('owner')} />
                </View>
                <Muted>オーナーはスタッフの追加・停止を管理できます。必要な人だけに付与してください。</Muted>
                <Button label="権限を追加する確認へ" disabled={disabled || !newUid.trim()} onPress={() => setConfirmation({ kind: 'staff', uid: newUid.trim(), role: newRole, active: true })} />
                {accounts.map((account) => (
                  <View key={account.uid} style={s.section}>
                    <Text selectable style={s.uid}>UID {account.uid}</Text>
                    <Tag tone={account.active ? 'green' : 'muted'}>{account.role === 'owner' ? 'オーナー' : 'スタッフ'}・{account.active ? '有効' : '停止中'}</Tag>
                    {account.uid === staff.uid && <Muted>現在ログインしているあなたのアカウントです。</Muted>}
                    <Button
                      label={account.active ? 'この人のスタッフ権限を停止する' : 'この人のスタッフ権限を再開する'}
                      variant="secondary"
                      disabled={disabled}
                      onPress={() => setConfirmation({ kind: 'staff', uid: account.uid, role: account.role, active: !account.active })}
                    />
                  </View>
                ))}
                <Muted>最後の有効なオーナーは停止できません。先に別のオーナーを追加してください。</Muted>
              </Card>
              <Card>
                <Heading>操作の記録</Heading>
                {audit.length === 0 && <Muted>記録はまだありません。</Muted>}
                {audit.map((record) => (
                  <View key={record.id} style={s.section}>
                    <Text style={styles.body}>{actionLabel(record.action)}</Text>
                    <Muted>{dateTime(record.createdAt)}</Muted>
                    <Text selectable style={s.uid}>操作したUID {record.actorUid}</Text>
                    <Text selectable style={s.uid}>対象 {record.targetId}</Text>
                  </View>
                ))}
              </Card>
            </>
          )}
        </>
      )}

      <Modal visible={confirmation !== null} transparent animationType="fade" onRequestClose={() => { if (!busy) setConfirmation(null); }}>
        <View style={s.overlay}>
          <SafeAreaView style={s.modal}>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.modalContent}>
              <Heading>{confirmation?.kind === 'stamp' ? '来店を確認しましたか？' : confirmation?.kind === 'coupon' ? '特典を使用しますか？' : '権限を変更しますか？'}</Heading>
              {confirmation?.kind === 'stamp' && <>
                <Text style={styles.body}>{confirmation.nickname}さんに1スタンプを付与します。{store.reward.stampsRequired}スタンプに達すると残高から消費して特典を発行します。</Text>
                <Text style={s.subheading}>確認したお会計：{confirmation.purchaseAmountYen.toLocaleString('ja-JP')}円</Text>
                <Muted>実際の来店とレジのお会計を確認してください。</Muted>
              </>}
              {confirmation?.kind === 'coupon' && <>
                <Text style={styles.body}>{confirmation.nickname}さんの「{confirmation.label}」を使用済みにします。対象商品とお客さんの画面の特典番号をご確認ください。</Text>
                <Text selectable style={s.uid}>特典番号 {confirmation.couponId}</Text>
                {confirmation.purchaseAmountYen > 0 && <Text style={s.subheading}>確認したお会計：{confirmation.purchaseAmountYen.toLocaleString('ja-JP')}円</Text>}
                <Muted>使用済みにすると再利用できません。</Muted>
              </>}
              {confirmation?.kind === 'staff' && <>
                <Text selectable style={s.uid}>対象UID {confirmation.uid}</Text>
                <Text style={styles.body}>{confirmation.role === 'owner' ? 'オーナー' : 'スタッフ'}権限を{confirmation.active ? '有効にします' : '停止します'}。本人のUIDであることを確認してください。</Text>
              </>}
              <Button label={confirmation?.kind === 'stamp' ? '確認して1スタンプ付与' : confirmation?.kind === 'coupon' ? '確認して使用済みにする' : '確認して権限を変更'} loading={busy} disabled={disabled} onPress={() => { void confirm(); }} />
              <Button label="キャンセル" variant="secondary" disabled={busy} onPress={() => setConfirmation(null)} />
              {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>

      <Modal visible={editing !== null} transparent animationType="fade" onRequestClose={() => { if (!busy) setEditing(null); }}>
        <View style={s.overlay}>
          <SafeAreaView style={s.modal}>
            <ScrollView automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" contentContainerStyle={s.modalContent}>
              <Heading>{editing?.id ? 'お知らせを編集' : 'お知らせを追加'}</Heading>
              <Text style={styles.label}>見出し</Text>
              <TextInput
                accessibilityLabel="お知らせの見出し"
                value={editing?.title ?? ''}
                onChangeText={(title) => setEditing((current) => current ? { ...current, title } : current)}
                editable={!disabled}
                maxLength={80}
                style={styles.input}
              />
              <Text style={styles.label}>本文</Text>
              <TextInput
                accessibilityLabel="お知らせの本文"
                value={editing?.body ?? ''}
                onChangeText={(body) => setEditing((current) => current ? { ...current, body } : current)}
                editable={!disabled}
                multiline
                maxLength={1000}
                style={[styles.input, { minHeight: 150, textAlignVertical: 'top' }]}
              />
              <Button label="お知らせを保存" loading={busy} disabled={disabled || !editing?.title.trim() || !editing?.body.trim()} onPress={() => {
                const input = editing;
                if (!input) return;
                void run(async () => {
                  await api.saveNotice(input);
                  if (!alive.current) return;
                  setEditing(null);
                  await refresh();
                  await onChanged();
                  setMessage('お知らせを公開しました。');
                });
              }} />
              <Button label="キャンセル" variant="secondary" disabled={busy} onPress={() => setEditing(null)} />
              {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>
    </ScrollView>
  );
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    'stamp.granted': 'スタンプ付与', 'stamp.grant': 'スタンプ付与',
    'coupon.redeemed': '特典利用', 'coupon.redeem': '特典利用',
    'coupon.issue': '特典の発行',
    'member.registered': '会員登録', 'member.register': '会員登録',
    'member.updated': '会員情報の変更', 'member.nickname': 'ニックネーム変更',
    'notice.saved': 'お知らせの保存', 'notice.save': 'お知らせの保存',
    'notice.update': 'お知らせの更新', 'notice.create': 'お知らせの追加',
    'staff.updated': 'スタッフ権限の変更', 'staff.set': 'スタッフ権限の変更',
    'staff.activate': 'スタッフ権限の開始', 'staff.deactivate': 'スタッフ権限の停止',
    'owner.bootstrap': '最初のオーナーの設定', 'account.deletion_requested': '退会申請',
    'account.deletion.request': '退会申請',
    'account.deleted': '退会処理',
  };
  return labels[action] ?? '管理操作';
}

const s = StyleSheet.create({
  content: { padding: 20, gap: 20, paddingBottom: 48 },
  header: { gap: 16 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metric: { flexGrow: 1, flexBasis: 90, minWidth: 80, padding: 12, borderRadius: 12, backgroundColor: theme.white, gap: 8 },
  metricValue: { fontSize: 28, lineHeight: 38, fontWeight: '700', color: theme.green },
  metricLabel: { fontSize: 14, lineHeight: 23, color: theme.muted },
  memberName: { fontSize: 24, lineHeight: 36, color: theme.ink, fontWeight: '700' },
  balance: { fontSize: 25, lineHeight: 38, color: theme.green, fontWeight: '700' },
  subheading: { fontSize: 18, lineHeight: 29, color: theme.ink, fontWeight: '600' },
  section: { paddingTop: 16, gap: 12, borderTopWidth: 1, borderColor: theme.line },
  uid: { fontSize: 14, lineHeight: 24, color: theme.muted, flexShrink: 1 },
  roleChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  errorBox: { padding: 16, borderRadius: 12, backgroundColor: '#FFF0EA' },
  messageBox: { padding: 16, borderRadius: 12, backgroundColor: theme.pale },
  overlay: { flex: 1, backgroundColor: '#16251EBB', justifyContent: 'center', alignItems: 'center', padding: 16 },
  modal: { width: '100%', maxWidth: 500, maxHeight: '92%', backgroundColor: theme.cream, borderRadius: 18 },
  modalContent: { padding: 22, gap: 18 },
});
