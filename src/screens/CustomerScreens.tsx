import React, { useEffect, useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { SafeAreaView } from 'react-native-safe-area-context';
import { shop } from '../config/shop';
import { couponStatus, memberQr } from '../domain/logic';
import type { Coupon, CouponStatus, DemoData, Member } from '../domain/types';
import { Button, Card, Heading, Muted, Tag, styles, theme } from '../ui';

export type CustomerTab = 'ホーム' | '会員証' | '特典' | 'お店';
type Props = {
  tab: CustomerTab;
  data: DemoData;
  onTab: (tab: CustomerTab) => void;
  onRegister: (nickname: string) => Promise<void>;
  onSelectMember: (id: string) => Promise<void>;
};

const statusLabels: Record<CouponStatus, string> = { available: '未使用', used: '使用済み', expired: '期限切れ' };
const yen = (amount: number) => amount.toLocaleString('ja-JP');
function dateLabel(value: string) {
  return new Date(value).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Tokyo' });
}
function expiryLabel(value: string) {
  return new Date(value).toLocaleString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tokyo' });
}

function StatusTag({ status }: { status: CouponStatus }) {
  return <Tag tone={status === 'available' ? 'green' : 'muted'}>{statusLabels[status]}</Tag>;
}

function RuleNote() {
  return (
    <View style={cs.ruleNote}>
      <Text style={cs.ruleTitle}>試作用のルール</Text>
      <Muted style={{ fontSize: 14 }}>来店スタンプは1日{shop.reward.dailyLimit}個。{shop.reward.stampsRequired}個たまると{yen(shop.reward.discountYen)}円割引の特典を発行。有効期限は発行から{shop.reward.validityDays}日です。</Muted>
      <Muted style={{ fontSize: 14 }}>スタンプ付与・特典の使用処理は、店舗スタッフが行います。</Muted>
    </View>
  );
}

function StampGrid({ count, compact = false }: { count: number; compact?: boolean }) {
  return (
    <View accessible accessibilityLabel={`スタンプ${shop.reward.stampsRequired}個中${count}個`} style={[cs.stampGrid, compact && { gap: 7 }]}>
      {Array.from({ length: shop.reward.stampsRequired }, (_, index) => {
        const filled = index < count;
        const reward = index === shop.reward.stampsRequired - 1;
        return (
          <View key={index} accessible={false} style={[cs.stamp, compact && cs.smallStamp, filled && cs.stampFilled, reward && !filled && cs.rewardStamp]}>
            <Text accessible={false} allowFontScaling={false} style={[cs.stampText, compact && { fontSize: 15 }, filled && { color: theme.white }, reward && !filled && { color: theme.gold }]}>{filled ? '玉' : reward ? '特典' : String(index + 1).padStart(2, '0')}</Text>
          </View>
        );
      })}
    </View>
  );
}

function Progress({ member }: { member?: Member }) {
  const count = member?.stamps ?? 0;
  return (
    <View style={{ gap: 18 }}>
      <View style={[styles.row, { justifyContent: 'space-between', alignItems: 'flex-end' }]}>
        <View style={{ gap: 4 }}>
          <Text style={styles.eyebrow}>ご来店スタンプ</Text>
          <View style={[styles.row, { gap: 6, alignItems: 'baseline' }]}>
            <Text style={cs.stampCount}>{count}</Text>
            <Text style={cs.stampUnit}>/ {shop.reward.stampsRequired} 個</Text>
          </View>
        </View>
        <View style={{ paddingBottom: 5 }}>
          <Muted>次の特典まで</Muted>
          <Text style={cs.nextReward}>あと <Text style={{ fontWeight: '800' }}>{shop.reward.stampsRequired - count}</Text> 個</Text>
        </View>
      </View>
      <StampGrid count={count} compact />
    </View>
  );
}

function DecorativeSweet() {
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={cs.sweetArt}>
      <View style={cs.sweetBack} />
      <View style={cs.sweetFront}><View style={cs.sweetInner}><Text accessible={false} allowFontScaling={false} style={cs.sweetKanji}>玉</Text></View></View>
      <View style={cs.sweetLeaf} />
      <View style={cs.sweetLine} />
      <Text style={cs.artCaption}>和菓子と、日々。</Text>
    </View>
  );
}

function CouponCard({ coupon, onOpen, now }: { coupon: Coupon; onOpen: () => void; now: Date }) {
  const status = couponStatus(coupon, now);
  return (
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${yen(shop.reward.discountYen)}円割引、${statusLabels[status]}。詳細をひらく`} style={({ pressed }) => [cs.couponCard, status !== 'available' && { backgroundColor: '#F7F8F5' }, pressed && { opacity: 0.72 }]}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={cs.couponMark}><Text accessible={false} allowFontScaling={false} style={cs.couponMarkText}>特</Text></View>
      <View style={{ flex: 1, minWidth: 130, gap: 8 }}>
        <Text style={cs.couponTitle}>{yen(shop.reward.discountYen)}<Text style={{ fontSize: 16 }}> 円割引</Text></Text>
        <Muted style={{ fontSize: 14 }}>{status === 'used' && coupon.usedAt ? `使用日 ${dateLabel(coupon.usedAt)}` : `有効期限 ${expiryLabel(coupon.expiresAt)}`}</Muted>
        {(coupon.id === 'coupon_demo_used' || coupon.id === 'coupon_demo_expired') && <Muted style={{ fontSize: 14 }}>過去の特典サンプル</Muted>}
      </View>
      <View style={{ gap: 10, alignItems: 'flex-end' }}><StatusTag status={status} /><Text style={cs.arrow}>→</Text></View>
    </Pressable>
  );
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return <Card style={cs.empty}><View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={cs.emptyMotif}><Text accessible={false} allowFontScaling={false} style={cs.emptyMotifText}>玉</Text></View><Text style={cs.emptyTitle}>{title}</Text><Muted style={{ textAlign: 'center' }}>{body}</Muted>{action}</Card>;
}

export function CustomerScreens({ tab, data, onTab, onRegister }: Props) {
  const { width } = useWindowDimensions();
  const [containerWidth, setContainerWidth] = useState(Math.min(width, 560));
  const wide = containerWidth >= 820;
  const [now, setNow] = useState(() => new Date());
  const [nickname, setNickname] = useState('');
  const [registering, setRegistering] = useState(false);
  const [registrationError, setRegistrationError] = useState('');
  const [couponFilter, setCouponFilter] = useState<'all' | CouponStatus>('all');
  const [selectedCouponId, setSelectedCouponId] = useState<string | null>(null);
  const [couponStep, setCouponStep] = useState<'detail' | 'confirm' | 'present'>('detail');
  const member = data.members.find((item) => item.id === data.currentMemberId);
  const memberCoupons = data.coupons.filter((coupon) => coupon.memberId === member?.id).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  const availableCoupons = memberCoupons.filter((coupon) => couponStatus(coupon, now) === 'available');
  const selectedCoupon = memberCoupons.find((coupon) => coupon.id === selectedCouponId);
  const history = data.stamps.filter((stamp) => stamp.memberId === member?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const notices = [...data.notices].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { setSelectedCouponId(null); }, [data.currentMemberId]);
  const openCoupon = (coupon: Coupon) => { setNow(new Date()); setCouponStep('detail'); setSelectedCouponId(coupon.id); };
  const register = async () => {
    const cleaned = nickname.trim();
    if (!cleaned) { setRegistrationError('ニックネームを入力してください。'); return; }
    setRegistrationError('');
    setRegistering(true);
    try { await onRegister(cleaned); setNickname(''); }
    catch { setRegistrationError('登録できませんでした。もう一度お試しください。'); }
    finally { setRegistering(false); }
  };

  return (
    <>
      <ScrollView onLayout={({ nativeEvent }) => setContainerWidth(nativeEvent.layout.width)} style={styles.screen} contentContainerStyle={[styles.content, containerWidth < 600 && { padding: 18, gap: 20 }]} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        {tab === 'ホーム' && (
          <>
            <View style={cs.pageIntro}><Text style={styles.eyebrow}>日々のおいしさに、ひとつずつ。</Text><Text accessibilityRole="header" style={cs.shopName}>{shop.name}</Text><Muted>和菓子を楽しむ、玉屋の会員アプリ</Muted></View>
            <View style={[cs.homeTop, wide && { flexDirection: 'row' }]}>
              <Card style={[wide && { flex: 1 }, { justifyContent: 'space-between' }]}>
                <View style={[styles.row, { justifyContent: 'space-between' }]}><Text style={styles.label}>{member ? `${member.nickname} さん` : '玉屋のスタンプをはじめる'}</Text>{member?.sample && <Tag tone="gold">サンプル会員</Tag>}</View>
                <Button label={member ? '会員証をひらく　→' : '会員登録する　→'} onPress={() => onTab('会員証')} />
                <Progress member={member} />
                <Muted style={{ textAlign: 'center', fontSize: 14 }}>{member ? 'お会計時に、会員証をご提示ください' : 'ニックネームだけで、試用をはじめられます'}</Muted>
              </Card>
              <View style={[cs.hero, wide && { flex: 1.12 }]}>
                <Tag tone="gold">玉屋の会員さまへ</Tag>
                <Text style={[cs.heroTitle, containerWidth < 600 && { fontSize: 28, lineHeight: 44 }]}>いつものおいしさに、{wide ? '\n' : ''}小さな楽しみを。</Text>
                <Text style={cs.heroBody}>ご来店のたびにスタンプを。{ '\n' }たまったら、うれしい特典に。</Text>
                <DecorativeSweet />
                <Text style={cs.heroFoot}>むさしの玉屋　会員プログラム</Text>
              </View>
            </View>
            <View style={[cs.columns, wide && { flexDirection: 'row' }]}>
              <View style={{ flex: 1, gap: 16 }}>
                <SectionHeader title="お知らせ" caption="玉屋からのご案内" />
                <Card style={{ gap: 0 }}>
                  {notices.length === 0 ? <Muted>新しいお知らせはありません。</Muted> : notices.slice(0, 3).map((notice, index) => (
                    <View key={notice.id} style={[cs.notice, index > 0 && { borderTopWidth: 1, borderTopColor: theme.line }]}>
                      <Text style={cs.noticeDate}>{dateLabel(notice.updatedAt)}</Text>
                      <Text style={cs.noticeTitle}>{notice.title}</Text>
                      <Muted>{notice.body}</Muted>
                    </View>
                  ))}
                </Card>
              </View>
              <View style={{ flex: 1, gap: 16 }}>
                <SectionHeader title="お持ちの特典" caption="スタンプから、楽しみへ" action={<Pressable accessibilityRole="button" onPress={() => onTab('特典')} style={cs.textLink}><Text style={cs.textLinkLabel}>すべて見る　→</Text></Pressable>} />
                {availableCoupons.length ? availableCoupons.slice(0, 2).map((coupon) => <CouponCard key={coupon.id} coupon={coupon} now={now} onOpen={() => openCoupon(coupon)} />) : <Card style={{ minHeight: 168, justifyContent: 'center' }}><Text style={cs.smallCardTitle}>{member ? '特典を楽しみに、ひとつずつ。' : 'スタンプが、特典になります。'}</Text><Muted>{member ? `あと${shop.reward.stampsRequired - member.stamps}個のスタンプで、${yen(shop.reward.discountYen)}円割引の特典をお届けします。` : `${shop.reward.stampsRequired}個たまると、${yen(shop.reward.discountYen)}円割引の特典を受け取れます。`}</Muted></Card>}
              </View>
            </View>
            <RuleNote />
          </>
        )}

        {tab === '会員証' && (
          <>
            <Heading eyebrow="玉屋の会員プログラム">{member ? 'あなたの会員証' : '玉屋の楽しみを、もうひとつ。'}</Heading>
            {member ? (
              <>
                <View style={[cs.columns, wide && { flexDirection: 'row', alignItems: 'flex-start' }]}>
                  <Card style={[cs.membership, wide && { flex: 1 }]}>
                    <View style={[styles.row, { justifyContent: 'space-between' }]}><Text style={cs.membershipBrand}>{shop.name}</Text><Tag tone="gold">会員証</Tag></View>
                    <View style={{ alignItems: 'center', gap: 8 }}><Text style={cs.memberName}>{member.nickname}<Text style={{ fontSize: 14 }}> さん</Text></Text><Muted>会員番号 {member.number}</Muted></View>
                    <View accessible accessibilityLabel={`スタッフ読み取り用の会員QRコード。会員番号${member.number}`} style={cs.qrWrap}><QRCode value={memberQr(member)} size={190} color={theme.ink} backgroundColor={theme.white} /></View>
                    <Muted style={{ textAlign: 'center' }}>お会計の際、こちらのQRコードを{ '\n' }店舗スタッフにご提示ください。</Muted>
                    {member.sample && <View style={cs.sampleNote}><Text style={cs.sampleNoteTitle}>試用向けのサンプル会員です</Text><Muted style={{ fontSize: 14 }}>デモの記録が含まれています。実際の会員証としてはご利用いただけません。</Muted></View>}
                  </Card>
                  <View style={[{ gap: 20 }, wide && { flex: 1.12 }]}>
                    <Card><Progress member={member} /><View style={styles.divider} /><View style={styles.row}><View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={cs.rewardIcon}><Text accessible={false} allowFontScaling={false} style={{ color: theme.gold, fontSize: 21 }}>特</Text></View><View style={{ flex: 1, minWidth: 140, gap: 3 }}><Text style={cs.smallCardTitle}>次の特典は、{yen(shop.reward.discountYen)}円割引</Text><Muted>スタンプ{shop.reward.stampsRequired}個で自動発行されます。</Muted></View></View>{availableCoupons.length > 0 && <Button label={`未使用の特典を見る（${availableCoupons.length}件）`} variant="secondary" onPress={() => onTab('特典')} />}</Card>
                    <Card><Heading style={{ fontSize: 19 }}>ご来店の記録</Heading>{history.length === 0 ? <Muted>はじめてのスタンプをお待ちしています。</Muted> : history.slice(0, 5).map((stamp) => <View key={stamp.id} style={cs.historyRow}><View style={cs.historyDot} /><View style={{ flex: 1 }}><Text style={styles.label}>{stamp.source === 'sample' ? 'サンプルスタンプ' : 'ご来店スタンプ'}</Text><Muted style={{ fontSize: 12 }}>{stamp.japanDate.replace(/-/g, '.')}</Muted></View><Text style={cs.historyCount}>＋1</Text></View>)}{history.length > 5 && <Muted style={{ fontSize: 11 }}>直近5件を表示しています。累計 {history.length}個</Muted>}</Card>
                  </View>
                </View>
              </>
            ) : (
              <View style={[cs.columns, wide && { flexDirection: 'row', alignItems: 'flex-start' }]}>
                <Card style={[{ gap: 22 }, wide && { flex: 1 }]}>
                  <View style={{ gap: 10 }}><Tag>新規会員登録</Tag><Text style={cs.smallCardTitle}>あなたの会員証をつくる</Text><Muted>ニックネームを登録すると、会員証のQRコードが表示されます。</Muted></View>
                  <View style={{ gap: 9 }}><Text style={styles.label}>ニックネーム</Text><TextInput accessibilityLabel="ニックネーム" placeholder="例：たまちゃん" placeholderTextColor={theme.muted} value={nickname} onChangeText={(value) => { setNickname(value); setRegistrationError(''); }} maxLength={20} style={styles.input} autoCapitalize="none" returnKeyType="done" onSubmitEditing={register} editable={!registering} /><Muted style={{ fontSize: 14 }}>20文字以内。店舗スタッフにも表示されます。</Muted>{registrationError ? <Text accessibilityRole="alert" style={styles.error}>{registrationError}</Text> : null}</View>
                  <Button label="会員証をつくる" loading={registering} onPress={register} testID="register-member" />
                  <Muted style={{ fontSize: 14 }}>このアプリは試作版です。会員情報はこの端末に保存されます。</Muted>
                </Card>
                <View style={[cs.registrationStory, wide && { flex: 1 }]}><View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={cs.storySeal}><Text accessible={false} allowFontScaling={false} style={cs.storySealText}>玉</Text></View><Heading style={{ fontSize: 23 }}>ご来店を、{ '\n' }ささやかな楽しみに。</Heading><Muted>お買い物の際に会員証をご提示いただくと、スタッフが来店スタンプを付与します。</Muted><StampGrid count={0} compact /><Text style={cs.nextReward}>{shop.reward.stampsRequired}個で {yen(shop.reward.discountYen)}円割引</Text></View>
              </View>
            )}
            <RuleNote />
          </>
        )}

        {tab === '特典' && (
          <>
            <Heading eyebrow="ご来店に、ありがとうを。">あなたの特典</Heading>
            <Muted>店頭で画面を提示して、店舗スタッフにお声がけください。</Muted>
            {!member ? <EmptyState title="会員証をつくって、特典を楽しむ" body={`スタンプ${shop.reward.stampsRequired}個で、${yen(shop.reward.discountYen)}円割引の特典が発行されます。`} action={<Button label="会員登録へ" onPress={() => onTab('会員証')} style={{ alignSelf: 'stretch' }} />} /> : (
              <>
                <View accessibilityRole="tablist" style={cs.filterRow}>
                  {([['all', 'すべて'], ['available', '未使用'], ['used', '使用済み'], ['expired', '期限切れ']] as const).map(([value, label]) => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: couponFilter === value }} onPress={() => setCouponFilter(value)} style={[cs.filter, couponFilter === value && cs.filterSelected]}><Text style={[cs.filterText, couponFilter === value && { color: theme.white }]}>{label}</Text></Pressable>)}
                </View>
                {memberCoupons.filter((coupon) => couponFilter === 'all' || couponStatus(coupon, now) === couponFilter).length > 0 ? <View style={cs.couponList}>{memberCoupons.filter((coupon) => couponFilter === 'all' || couponStatus(coupon, now) === couponFilter).map((coupon) => <View key={coupon.id} style={wide ? { width: '48.8%' } : { width: '100%' }}><CouponCard coupon={coupon} now={now} onOpen={() => openCoupon(coupon)} /></View>)}</View> : <EmptyState title={couponFilter === 'all' ? '次のご来店も、お楽しみに。' : `${couponFilter === 'available' ? '未使用' : couponFilter === 'used' ? '使用済み' : '期限切れ'}の特典はありません`} body={couponFilter === 'all' || couponFilter === 'available' ? `あと${shop.reward.stampsRequired - member.stamps}個のスタンプで、次の特典が発行されます。` : '特典の状態はこちらで確認できます。'} />}
              </>
            )}
            <RuleNote />
          </>
        )}

        {tab === 'お店' && (
          <>
            <View style={cs.storeIntro}><Text style={styles.eyebrow}>お店のご案内</Text><Text accessibilityRole="header" style={[cs.shopName, { marginTop: 8 }]}>{shop.name}</Text><Muted>{shop.area}</Muted><View style={cs.storeAccent} /></View>
            <Card>
              <Heading style={{ fontSize: 21 }}>店舗情報</Heading>
              <InfoRow label="エリア" value={shop.area} />
              <InfoRow label="住所" value={shop.address ?? '店舗情報を確認中です'} />
              <InfoRow label="営業時間" value={shop.hours ?? '店舗情報を確認中です'} />
              <InfoRow label="電話番号" value={shop.phone ?? '店舗情報を確認中です'} />
              {(shop.address || shop.phone) && <View style={styles.row}>{shop.address && <Button label="地図で見る　↗" variant="secondary" onPress={() => { void Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(shop.address!)}`); }} />}{shop.phone && <Button label="電話をかける" variant="secondary" onPress={() => { void Linking.openURL(`tel:${shop.phone}`); }} />}</View>}
            </Card>
            <SectionHeader title="お知らせ" caption="玉屋からのご案内" />
            <Card style={{ gap: 0 }}>
              {notices.length === 0 ? <Muted>新しいお知らせはありません。</Muted> : notices.map((notice, index) => (
                <View key={notice.id} style={[cs.notice, index > 0 && { borderTopWidth: 1, borderTopColor: theme.line }]}>
                  <Text style={cs.noticeDate}>{dateLabel(notice.updatedAt)}</Text>
                  <Text style={cs.noticeTitle}>{notice.title}</Text>
                  <Muted>{notice.body}</Muted>
                </View>
              ))}
            </Card>
            <RuleNote />
          </>
        )}
        <View style={cs.footer}><Text style={cs.footerBrand}>{shop.name}</Text><Text style={cs.footerCaption}>和菓子と、日々。</Text></View>
      </ScrollView>
      <Modal visible={Boolean(selectedCoupon)} transparent animationType="fade" onRequestClose={() => setSelectedCouponId(null)}>
        <SafeAreaView style={cs.modalBackdrop}>
          <Pressable accessibilityLabel="特典を閉じる" accessibilityRole="button" onPress={() => setSelectedCouponId(null)} style={StyleSheet.absoluteFill} />
          <View accessibilityViewIsModal style={cs.modalCard}>
            <ScrollView contentContainerStyle={{ padding: 26, gap: 22 }}>
              <View style={[styles.row, { justifyContent: 'space-between' }]}><Text style={styles.eyebrow}>{couponStep === 'present' ? '店頭でのご提示' : '玉屋の特典'}</Text><Pressable accessibilityRole="button" accessibilityLabel="閉じる" onPress={() => setSelectedCouponId(null)} style={cs.closeButton}><Text style={cs.closeText}>×</Text></Pressable></View>
              {selectedCoupon && (() => {
                const status = couponStatus(selectedCoupon, now);
                if (couponStep === 'present') return <><Heading>スタッフにご提示ください</Heading><View style={cs.presentStatus}><Text style={cs.presentStatusLabel}>現在の状態</Text><Text style={[cs.presentStatusValue, status !== 'available' && { color: theme.muted }]}>{statusLabels[status]}</Text></View><View style={{ gap: 10 }}><Text style={styles.label}>クーポンID</Text><Text selectable style={cs.couponId}>{selectedCoupon.id}</Text></View><Muted>店舗スタッフがこのIDと状態を確認します。提示しただけでは使用済みになりません。</Muted><Button label="提示を終える" variant="secondary" onPress={() => setSelectedCouponId(null)} /></>;
                if (couponStep === 'confirm') return <><Heading>店舗スタッフにお声がけください</Heading><Muted>特典の使用は、店舗スタッフが内容を確認してから行います。この画面から使用処理はできません。</Muted><Muted>次の画面でクーポンIDと現在の状態を表示します。</Muted><Button label="クーポンを提示する" onPress={() => { setNow(new Date()); setCouponStep('present'); }} /><Button label="詳細に戻る" variant="ghost" onPress={() => setCouponStep('detail')} /></>;
                return <><StatusTag status={status} /><View style={{ gap: 10 }}><Text style={cs.couponDetailAmount}>{yen(shop.reward.discountYen)}<Text style={{ fontSize: 23 }}> 円割引</Text></Text><Muted>スタンプ{shop.reward.stampsRequired}個のご来店特典</Muted></View><View style={styles.divider} /><InfoRow label="発行日" value={dateLabel(selectedCoupon.issuedAt)} /><InfoRow label="有効期限" value={expiryLabel(selectedCoupon.expiresAt)} />{selectedCoupon.usedAt && <InfoRow label="使用日" value={dateLabel(selectedCoupon.usedAt)} />}<Muted>店頭でご提示ください。使用の確認と処理は店舗スタッフが行います。</Muted>{status === 'available' ? <Button label="店頭で提示する" onPress={() => setCouponStep('confirm')} testID="present-coupon" /> : <View style={cs.sampleNote}><Muted>この特典は{status === 'used' ? '使用済み' : '期限切れ'}です。</Muted></View>}</>;
              })()}
            </ScrollView>
          </View>
        </SafeAreaView>
      </Modal>
    </>
  );
}

function SectionHeader({ title, caption, action }: { title: string; caption: string; action?: React.ReactNode }) {
  return <View style={[styles.row, { justifyContent: 'space-between', alignItems: 'center' }]}><View style={{ gap: 4 }}><Text accessibilityRole="header" style={cs.sectionTitle}>{title}</Text><Muted style={{ fontSize: 11 }}>{caption}</Muted></View>{action}</View>;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return <View style={cs.infoRow}><Text style={cs.infoLabel}>{label}</Text><Text style={cs.infoValue}>{value}</Text></View>;
}

const cs = StyleSheet.create({
  pageIntro: { gap: 8, paddingVertical: 4 },
  shopName: { color: theme.ink, fontSize: 32, lineHeight: 47, letterSpacing: 2.5, fontWeight: '700' },
  homeTop: { gap: 20, alignItems: 'stretch' },
  hero: { backgroundColor: '#E9EEE3', borderRadius: 24, padding: 28, gap: 20, overflow: 'hidden' },
  heroTitle: { color: theme.green, fontWeight: '700', fontSize: 31, lineHeight: 48, letterSpacing: 1.3 },
  heroBody: { color: theme.green, fontSize: 15, lineHeight: 26, letterSpacing: 0.4 },
  heroFoot: { color: theme.green, fontSize: 10, letterSpacing: 2, borderTopWidth: 1, borderTopColor: '#CED8C6', paddingTop: 16 },
  sweetArt: { height: 145, alignSelf: 'flex-end', width: 240, marginTop: -7, marginBottom: -2 },
  sweetBack: { position: 'absolute', width: 116, height: 96, borderRadius: 58, top: 7, left: 24, borderWidth: 1, borderColor: '#B7BD9D', backgroundColor: '#E3DFC5', transform: [{ rotate: '-17deg' }] },
  sweetFront: { position: 'absolute', width: 126, height: 102, borderRadius: 60, top: 29, left: 63, borderWidth: 1, borderColor: '#9C9D75', backgroundColor: '#EADFC1', transform: [{ rotate: '10deg' }], alignItems: 'center', justifyContent: 'center' },
  sweetInner: { borderWidth: 1, borderColor: '#BBAA7C', width: 94, height: 72, borderRadius: 45, alignItems: 'center', justifyContent: 'center' },
  sweetKanji: { fontSize: 37, color: '#9B8554', fontWeight: '500' },
  sweetLeaf: { width: 66, height: 30, backgroundColor: '#5B7457', borderTopLeftRadius: 60, borderBottomRightRadius: 60, position: 'absolute', right: 3, bottom: 26, transform: [{ rotate: '-28deg' }] },
  sweetLine: { position: 'absolute', bottom: 10, left: 15, right: 4, height: 1, backgroundColor: '#C8CEBC' },
  artCaption: { position: 'absolute', right: 1, top: 3, fontSize: 9, letterSpacing: 1.4, color: '#7C896E' },
  stampCount: { fontSize: 51, lineHeight: 60, fontWeight: '600', color: theme.green, letterSpacing: -2 },
  stampUnit: { fontSize: 14, color: theme.muted },
  nextReward: { color: theme.green, fontSize: 17, lineHeight: 27 },
  stampGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'flex-start' },
  stamp: { height: 52, width: 52, borderRadius: 26, borderWidth: 1, borderStyle: 'dashed', borderColor: '#CED4C8', backgroundColor: '#FAFBF8', alignItems: 'center', justifyContent: 'center' },
  smallStamp: { width: 43, height: 43, borderRadius: 22 },
  stampFilled: { backgroundColor: theme.green, borderColor: theme.green, borderStyle: 'solid' },
  rewardStamp: { borderColor: '#C9BA94', backgroundColor: '#F6F1E6' },
  stampText: { color: '#A0A89A', fontSize: 17, fontWeight: '500' },
  columns: { gap: 22 },
  sectionTitle: { color: theme.ink, fontSize: 20, lineHeight: 28, fontWeight: '700', letterSpacing: 0.8 },
  notice: { paddingVertical: 15, gap: 7 },
  noticeDate: { color: theme.gold, fontSize: 10, lineHeight: 17, letterSpacing: 0.5 },
  noticeTitle: { color: theme.ink, fontSize: 15, lineHeight: 24, fontWeight: '600' },
  textLink: { minHeight: 48, justifyContent: 'center', paddingLeft: 12 },
  textLinkLabel: { color: theme.green, fontSize: 15, lineHeight: 25, fontWeight: '600' },
  smallCardTitle: { color: theme.ink, fontSize: 16, lineHeight: 26, fontWeight: '600' },
  ruleNote: { padding: 18, gap: 5, borderRadius: 14, borderColor: '#DDDCD0', borderWidth: 1, backgroundColor: '#F0EFE5' },
  ruleTitle: { color: theme.green, fontSize: 12, lineHeight: 19, fontWeight: '600', letterSpacing: 0.8 },
  couponCard: { minHeight: 135, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', backgroundColor: theme.white, padding: 20, gap: 16, borderRadius: 19, borderWidth: 1, borderColor: '#DBDFD3' },
  couponMark: { width: 46, height: 56, borderColor: '#C2B082', borderWidth: 1, borderRadius: 4, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FBF8F0' },
  couponMarkText: { color: theme.gold, fontSize: 24 },
  couponTitle: { color: theme.green, fontSize: 29, lineHeight: 38, fontWeight: '600' },
  arrow: { color: theme.green, fontSize: 20 },
  membership: { borderTopWidth: 4, borderTopColor: theme.green, alignItems: 'stretch', gap: 26 },
  membershipBrand: { color: theme.green, fontSize: 17, lineHeight: 27, fontWeight: '700', letterSpacing: 1.1 },
  memberName: { color: theme.ink, fontSize: 23, lineHeight: 35, fontWeight: '600', textAlign: 'center' },
  qrWrap: { alignSelf: 'center', padding: 20, backgroundColor: theme.white, borderWidth: 1, borderColor: '#E1E5DC', borderRadius: 16 },
  sampleNote: { backgroundColor: '#F5F0E4', borderRadius: 12, padding: 14, gap: 5 },
  sampleNoteTitle: { color: theme.gold, fontSize: 14, lineHeight: 23, fontWeight: '600' },
  rewardIcon: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#F3EEE2', alignItems: 'center', justifyContent: 'center' },
  historyRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 2 },
  historyDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#789076' },
  historyCount: { color: theme.green, fontSize: 15, fontWeight: '600' },
  registrationStory: { padding: 25, gap: 21 },
  storySeal: { width: 58, height: 65, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 5, borderColor: theme.gold },
  storySealText: { fontSize: 34, color: theme.gold },
  empty: { alignItems: 'center', paddingVertical: 36, gap: 15 },
  emptyMotif: { width: 56, height: 56, borderRadius: 28, backgroundColor: theme.pale, alignItems: 'center', justifyContent: 'center' },
  emptyMotifText: { color: '#75916B', fontSize: 27 },
  emptyTitle: { color: theme.ink, fontSize: 18, lineHeight: 29, textAlign: 'center', fontWeight: '600' },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  filter: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 12, paddingHorizontal: 19, paddingVertical: 12, borderWidth: 1, borderColor: theme.line, backgroundColor: theme.white },
  filterSelected: { backgroundColor: theme.green, borderColor: theme.green },
  filterText: { color: theme.muted, fontSize: 15, lineHeight: 25, fontWeight: '600' },
  couponList: { flexDirection: 'row', flexWrap: 'wrap', gap: 18, justifyContent: 'space-between' },
  storeIntro: { paddingVertical: 8, gap: 10 },
  storeAccent: { width: 44, height: 3, backgroundColor: theme.gold, marginTop: 9 },
  infoRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 12 },
  infoLabel: { width: 85, fontSize: 15, lineHeight: 25, color: theme.muted },
  infoValue: { flex: 1, minWidth: 130, fontSize: 16, lineHeight: 27, color: theme.ink },
  footer: { alignItems: 'center', gap: 6, paddingTop: 14, paddingBottom: 5 },
  footerBrand: { color: theme.green, fontSize: 14, lineHeight: 23, letterSpacing: 1.5, fontWeight: '600' },
  footerCaption: { color: theme.muted, fontSize: 10, lineHeight: 18, letterSpacing: 1.5 },
  modalBackdrop: { flex: 1, backgroundColor: '#19251CCC', justifyContent: 'center', alignItems: 'center', padding: 18 },
  modalCard: { width: '100%', maxWidth: 520, maxHeight: '90%', backgroundColor: theme.white, borderRadius: 24, overflow: 'hidden' },
  closeButton: { width: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24, backgroundColor: '#F0F2EB' },
  closeText: { color: theme.green, fontSize: 28, lineHeight: 35 },
  couponDetailAmount: { color: theme.green, fontSize: 48, lineHeight: 61, fontWeight: '600' },
  presentStatus: { backgroundColor: theme.pale, borderRadius: 17, padding: 22, gap: 10, alignItems: 'center' },
  presentStatusLabel: { color: theme.muted, fontSize: 13, lineHeight: 21 },
  presentStatusValue: { color: theme.green, fontSize: 33, lineHeight: 45, fontWeight: '700' },
  couponId: { fontSize: 16, lineHeight: 27, color: theme.ink, backgroundColor: '#F2F3ED', padding: 16, borderRadius: 12, fontFamily: 'monospace' },
});
