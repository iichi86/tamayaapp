import React, { useEffect, useRef, useState } from "react";
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { DemoData, Notice } from "../domain/types";
import { couponStatus, japanDate, parseMemberQr, stats } from "../domain/logic";
import { shop } from "../config/shop";
import { Button, Card, Heading, Muted, Tag } from "../ui";
import { Scanner } from "./Scanner";

type Props = {
  data: DemoData;
  initialMemberId: string | null;
  onGrant: (id: string) => Promise<void>;
  onRedeem: (id: string) => Promise<void>;
  onNotice: (notice: {
    id?: string;
    title: string;
    body: string;
  }) => Promise<void>;
  report: (message: string) => void;
};
export function StaffScreen({
  data,
  initialMemberId,
  onGrant,
  onRedeem,
  onNotice,
  report,
}: Props) {
  const [memberId, setMemberId] = useState(initialMemberId);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    setMemberId(initialMemberId);
  }, [initialMemberId]);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);
  const [scanner, setScanner] = useState(false);
  const [picking, setPicking] = useState(false);
  const [confirm, setConfirm] = useState<{
    kind: "stamp" | "coupon";
    id: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const executing = useRef(false);
  const [editing, setEditing] = useState<{
    id?: string;
    title: string;
    body: string;
  } | null>(null);
  const member = data.members.find((m) => m.id === memberId);
  const confirmationMemberId =
    confirm?.kind === "stamp"
      ? confirm.id
      : data.coupons.find((c) => c.id === confirm?.id)?.memberId;
  const confirmingMember = data.members.find(
    (m) => m.id === confirmationMemberId,
  );
  const counts = stats(data, now);
  const stamped = data.stamps.some(
    (s) => s.memberId === memberId && s.japanDate === japanDate(now),
  );
  const coupons = data.coupons.filter((c) => c.memberId === memberId).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  async function runConfirm() {
    if (!confirm || executing.current) return;
    executing.current = true;
    setBusy(true);
    try {
      if (confirm.kind === "stamp") {
        await onGrant(confirm.id);
        report("スタンプを付与しました。お客さんの会員証にも反映されます。");
      } else {
        await onRedeem(confirm.id);
        report("クーポンを使用済みにしました。");
      }
      setConfirm(null);
    } catch (e) {
      report(e instanceof Error ? e.message : "処理を完了できませんでした。");
      setConfirm(null);
    } finally {
      executing.current = false;
      setBusy(false);
    }
  }
  async function submitNotice() {
    if (!editing || executing.current) return;
    executing.current = true;
    setBusy(true);
    try {
      await onNotice(editing);
      setEditing(null);
      report("お知らせを保存しました。");
    } catch (e) {
      report(e instanceof Error ? e.message : "保存できませんでした。");
    } finally {
      executing.current = false;
      setBusy(false);
    }
  }
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={s.content}
      keyboardShouldPersistTaps="handled"
    >
      <Heading eyebrow="店舗用 · 試作用">お店の受付</Heading>
      <Muted>
        お客さんの会員証を確認してから、来店スタンプや特典の利用を記録します。
      </Muted>
      <View style={s.metrics}>
        {[
          ["会員数", counts.members],
          ["今日の付与", counts.stampsToday],
          ["今日の特典利用", counts.redemptionsToday],
        ].map(([label, value]) => (
          <View style={s.metric} key={label}>
            <Text style={s.metricNumber}>{value}</Text>
            <Text style={s.metricLabel}>{label}</Text>
          </View>
        ))}
      </View>
      <Muted>日本時間で集計。サンプルの付与履歴も含みます。</Muted>
      <Card>
        <Heading>会員を確認する</Heading>
        <Button
          label="カメラで会員QRを読み取る"
          onPress={() => {
            setMemberId(null);
            setConfirm(null);
            setScanner(true);
            setPicking(false);
          }}
        />
        <Button
          label="デモ会員を選択する"
          variant="secondary"
          onPress={() => {
            setPicking(!picking);
            setScanner(false);
          }}
        />
        <Muted>デモ会員の選択は、カメラ読み取りとは別の試作用操作です。</Muted>
        {picking && (
          <View style={{ gap: 10 }}>
            {data.members.map((m) => (
              <Button
                key={m.id}
                label={`${m.nickname} · ${m.number}${m.sample ? "（9スタンプ開始のサンプル）" : ""}`}
                variant="secondary"
                onPress={() => {
                  setMemberId(m.id);
                  setPicking(false);
                  report(
                    `${m.nickname}さんを選択しました。会員を確認してから付与してください。`,
                  );
                }}
              />
            ))}
          </View>
        )}
        {scanner && (
          <Scanner
            onClose={() => setScanner(false)}
            onScan={(raw) => {
              setScanner(false);
              const id = parseMemberQr(raw);
              const found = data.members.find((m) => m.id === id);
              if (!found) {
                setMemberId(null);
                setConfirm(null);
                report("この端末に登録された玉屋のデモ会員QRではありません。");
                return;
              }
              setMemberId(found.id);
              report(`${found.nickname}さんの会員証を読み取りました。`);
            }}
          />
        )}
      </Card>
      {member ? (
        <Card>
          <Tag tone="green">確認対象の会員</Tag>
          <Text style={s.memberName}>{member.nickname}さん</Text>
          <Muted>会員番号 {member.number}</Muted>
          <Text style={s.balance}>現在 {member.stamps} スタンプ</Text>
          <Muted>
            試作用：1日1回。{shop.reward.stampsRequired}スタンプで
            {shop.reward.discountYen}
            円引きクーポンを発行し、スタンプを消費します。
          </Muted>
          <Button
            label={stamped ? "本日は付与済みです" : "スタンプ付与の確認へ"}
            disabled={busy || stamped}
            onPress={() => {
              setScanner(false);
              setConfirm({ kind: "stamp", id: member.id });
            }}
          />
          <Text style={s.sectionTitle}>この会員のクーポン</Text>
          {coupons.length === 0 && <Muted>まだクーポンはありません。</Muted>}
          {coupons.map((c) => {
            const status = couponStatus(c, now);
            return (
              <View key={c.id} style={s.coupon}>
                <View style={s.row}>
                  <Text style={s.couponTitle}>
                    {shop.reward.discountYen}円引き
                  </Text>
                  <Tag tone={status === "available" ? "green" : "muted"}>
                    {status === "available"
                      ? "未使用"
                      : status === "used"
                        ? "使用済み"
                        : "期限切れ"}
                  </Tag>
                </View>
                <Muted>特典番号 {c.id}</Muted>
                <Muted>
                  有効期限{" "}
                  {new Date(c.expiresAt).toLocaleString("ja-JP", {
                    timeZone: "Asia/Tokyo",
                  })}
                </Muted>
                <Button
                  label={
                    status === "available"
                      ? "特典利用の確認へ"
                      : "このクーポンは利用できません"
                  }
                  variant="secondary"
                  disabled={busy || status !== "available"}
                  onPress={() => {
                    setScanner(false);
                    setConfirm({ kind: "coupon", id: c.id });
                  }}
                />
              </View>
            );
          })}
        </Card>
      ) : (
        <Card>
          <Muted>会員QRを読み取るか、デモ会員を選択してください。</Muted>
        </Card>
      )}
      <Card>
        <Heading>お知らせの管理</Heading>
        <Button
          label="お知らせを追加"
          variant="secondary"
          onPress={() => setEditing({ title: "", body: "" })}
        />
        {data.notices.map((n: Notice) => (
          <View key={n.id} style={s.coupon}>
            <Text style={s.couponTitle}>{n.title}</Text>
            <Muted>{n.body}</Muted>
            <Button
              label={`「${n.title}」を編集`}
              variant="ghost"
              onPress={() =>
                setEditing({ id: n.id, title: n.title, body: n.body })
              }
            />
          </View>
        ))}
      </Card>
      <Modal
        visible={!!confirm}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!busy) setConfirm(null);
        }}
      >
        <View style={s.overlay}>
          <SafeAreaView style={s.modal}>
            <ScrollView contentContainerStyle={{ gap: 18 }}>
              <Heading>
                {confirm?.kind === "stamp"
                  ? "来店を確認しましたか？"
                  : "特典を使用しますか？"}
              </Heading>
              <Text style={s.body}>
                {confirm?.kind === "stamp"
                  ? `${confirmingMember?.nickname}さんに1スタンプを付与します。${shop.reward.stampsRequired}スタンプに達するとクーポンを発行します。`
                  : `${confirmingMember?.nickname}さんのクーポンを使用済みにします。お客さんが提示した特典番号を照合してください。`}
              </Text>
              {confirm?.kind === "coupon" && (
                <Muted>特典番号 {confirm.id}</Muted>
              )}
              <Button
                label={
                  confirm?.kind === "stamp"
                    ? "確認して1スタンプ付与"
                    : "確認して使用済みにする"
                }
                onPress={() => {
                  void runConfirm();
                }}
                loading={busy}
                disabled={busy}
              />
              <Button
                label="キャンセル"
                variant="secondary"
                onPress={() => setConfirm(null)}
                disabled={busy}
              />
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>
      <Modal
        visible={!!editing}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!busy) setEditing(null);
        }}
      >
        <View style={s.overlay}>
          <SafeAreaView style={s.modal}>
            <ScrollView
              automaticallyAdjustKeyboardInsets
              contentContainerStyle={{ gap: 16 }}
              keyboardShouldPersistTaps="handled"
            >
              <Heading>
                {editing?.id ? "お知らせを編集" : "お知らせを追加"}
              </Heading>
              <Text style={s.body}>見出し</Text>
              <TextInput
                editable={!busy}
                accessibilityLabel="お知らせの見出し"
                value={editing?.title ?? ""}
                onChangeText={(title) =>
                  setEditing((e) => (e ? { ...e, title } : e))
                }
                maxLength={80}
                style={s.input}
              />
              <Text style={s.body}>本文</Text>
              <TextInput
                editable={!busy}
                accessibilityLabel="お知らせの本文"
                multiline
                value={editing?.body ?? ""}
                onChangeText={(body) =>
                  setEditing((e) => (e ? { ...e, body } : e))
                }
                maxLength={1000}
                style={[s.input, { minHeight: 120, textAlignVertical: "top" }]}
              />
              <Button
                label="お知らせを保存"
                loading={busy}
                disabled={
                  busy || !editing?.title.trim() || !editing?.body.trim()
                }
                onPress={() => {
                  void submitNotice();
                }}
              />
              <Button
                label="キャンセル"
                variant="secondary"
                disabled={busy}
                onPress={() => setEditing(null)}
              />
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>
    </ScrollView>
  );
}
const s = StyleSheet.create({
  content: { padding: 22, gap: 20, paddingBottom: 40 },
  metrics: { flexDirection: "row", gap: 8 },
  metric: {
    flex: 1,
    backgroundColor: shop.colors.white,
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  metricNumber: { fontSize: 30, color: shop.colors.green, fontWeight: "600" },
  metricLabel: { fontSize: 13, color: shop.colors.muted },
  memberName: { fontSize: 25, color: shop.colors.ink, fontWeight: "600" },
  balance: { fontSize: 20, color: shop.colors.green },
  sectionTitle: {
    fontSize: 18,
    marginTop: 12,
    fontWeight: "600",
    color: shop.colors.ink,
  },
  coupon: {
    borderTopWidth: 1,
    borderColor: shop.colors.line,
    paddingTop: 16,
    gap: 10,
  },
  couponTitle: { fontSize: 18, color: shop.colors.ink, fontWeight: "600" },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  body: { fontSize: 17, lineHeight: 26, color: shop.colors.ink },
  overlay: {
    flex: 1,
    backgroundColor: "#16251EBB",
    justifyContent: "center",
    alignItems: "center",
    padding: 18,
  },
  modal: {
    backgroundColor: shop.colors.cream,
    padding: 24,
    borderRadius: 20,
    width: "100%",
    maxWidth: 500,
    maxHeight: "90%",
  },
  input: {
    backgroundColor: "white",
    borderWidth: 1,
    borderColor: shop.colors.line,
    borderRadius: 10,
    padding: 14,
    minHeight: 52,
    fontSize: 17,
    color: shop.colors.ink,
  },
});
