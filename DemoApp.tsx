import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import Svg, { Path, Rect, Circle } from "react-native-svg";
import { CustomerScreens } from "./src/screens/CustomerScreens";
import { StaffScreen } from "./src/screens/StaffScreen";
import { DemoRepository } from "./src/storage/DemoRepository";
import { asyncStorageAdapter } from "./src/storage/asyncStorageAdapter";
import {
  grantStamp,
  redeemCoupon,
  registerMember,
  saveNotice,
  selectMember,
} from "./src/domain/logic";
import { shop } from "./src/config/shop";
import { Button, Heading, Muted } from "./src/ui";

const repository = new DemoRepository(asyncStorageAdapter);
const tabs = ["ホーム", "会員証", "特典", "お店"] as const;
type Tab = (typeof tabs)[number];
function TabIcon({ tab, active }: { tab: Tab; active: boolean }) {
  const color = active ? shop.colors.green : shop.colors.muted;
  return (
    <Svg
      width={23}
      height={23}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.6}
      aria-hidden
    >
      {tab === "ホーム" ? (
        <Path d="M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-6v-7h-4v7H4a1 1 0 0 1-1-1Z" />
      ) : tab === "会員証" ? (
        <>
          <Rect x={2} y={5} width={20} height={15} rx={3} />
          <Circle cx={8} cy={11} r={2} />
          <Path d="M5 17c0-3 6-3 6 0M14 10h5m-5 4h5" />
        </>
      ) : tab === "特典" ? (
        <>
          <Rect x={3} y={9} width={18} height={12} rx={2} />
          <Path d="M2 9h20V6H2zm10-3v15M12 6C5 6 4 0 8 2c2 1 4 4 4 4Zm0 0c7 0 8-6 4-4-2 1-4 4-4 4Z" />
        </>
      ) : (
        <>
          <Path d="M3 10V4h18v6m-17 0v11h16V10M9 21v-7h6v7M2 10c0 3 5 3 5 0 0 3 5 3 5 0 0 3 5 3 5 0 0 3 5 3 5 0" />
        </>
      )}
    </Svg>
  );
}
export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}
function Main() {
  const data = useSyncExternalStore(
    repository.subscribe,
    repository.getSnapshot,
    repository.getSnapshot,
  );
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("ホーム");
  const [staff, setStaff] = useState(false);
  const [menu, setMenu] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const actionLock = useRef(false);
  useEffect(() => {
    repository
      .load()
      .catch((e) =>
        setError(
          e instanceof Error ? e.message : "データを読み込めませんでした。",
        ),
      );
  }, []);
  async function run(fn: () => Promise<unknown>) {
    if (actionLock.current)
      throw new Error("保存処理中です。完了してからもう一度お試しください。");
    actionLock.current = true;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : "保存できませんでした。もう一度お試しください。",
      );
      throw e;
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  async function pick(id: string) {
    await run(() => repository.transact((d) => selectMember(d, id)));
  }
  return (
    <SafeAreaView style={s.safe} edges={["top", "bottom"]}>
      <StatusBar style="dark" />
      <View style={s.app}>
        <View style={s.header}>
          <View style={s.brand}>
            <View style={s.mark}>
              <Text style={s.markText}>玉</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.brandName}>{shop.name}</Text>
              <Text style={s.brandSub}>
                {staff ? "店舗のデモ" : "会員のひろば"} · 試作用
              </Text>
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="デモメニューを開く"
            onPress={() => setMenu(true)}
            style={({ pressed }) => [s.menuButton, pressed && { opacity: 0.6 }]}
          >
            <Text style={s.menuText}>デモ</Text>
            <Text style={s.dots}>•••</Text>
          </Pressable>
        </View>
        <View style={s.body}>
          {!data ? (
            <View style={s.loading}>
              {error ? (
                <>
                  <Heading>保存データを読み込めません</Heading>
                  <Muted>{error}</Muted>
                  <Button
                    label="再読み込み"
                    onPress={() => {
                      setError(null);
                      repository.load().catch((e) => setError(e.message));
                    }}
                  />
                  <Button
                    label="デモデータをリセット"
                    variant="secondary"
                    onPress={() => setResetting(true)}
                  />
                </>
              ) : (
                <>
                  <ActivityIndicator color={shop.colors.green} />
                  <Muted>会員のひろばを準備しています</Muted>
                </>
              )}
            </View>
          ) : staff ? (
            <StaffScreen
              data={data}
              initialMemberId={data.currentMemberId}
              report={setMessage}
              onGrant={(id) =>
                run(() => repository.transact((d) => grantStamp(d, id)))
              }
              onRedeem={(id) =>
                run(() => repository.transact((d) => redeemCoupon(d, id)))
              }
              onNotice={(n) =>
                run(() => repository.transact((d) => saveNotice(d, n)))
              }
            />
          ) : (
            <CustomerScreens
              tab={tab}
              data={data}
              onTab={setTab}
              onRegister={async (nickname) => {
                await run(() =>
                  repository.transact((d) => registerMember(d, nickname)),
                );
                setMessage(
                  "会員登録が完了しました。0スタンプからのスタートです。",
                );
              }}
              onSelectMember={pick}
            />
          )}
        </View>
        {!staff && (
          <View style={s.tabs} accessibilityRole="tablist">
            {tabs.map((t) => (
              <Pressable
                key={t}
                accessibilityRole="tab"
                accessibilityLabel={t}
                accessibilityState={{ selected: t === tab }}
                onPress={() => setTab(t)}
                style={[s.tab, tab === t && s.activeTab]}
              >
                <TabIcon tab={t} active={tab === t} />
                <Text style={[s.tabText, tab === t && s.activeText]}>{t}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {staff && (
          <View style={s.staffFooter}>
            <Button
              label="お客さんの画面へ戻る"
              variant="ghost"
              onPress={() => setStaff(false)}
            />
          </View>
        )}
      </View>
      <Modal
        transparent
        visible={menu}
        animationType="fade"
        onRequestClose={() => setMenu(false)}
      >
        <View style={s.overlay}>
          <SafeAreaView style={s.modal}>
            <ScrollView contentContainerStyle={{ gap: 16 }}>
              <Heading eyebrow="この端末だけで試せます">デモメニュー</Heading>
              <Muted>
                架空の会員データを使う試作です。画面の切り替えは本番用の認証ではありません。
              </Muted>
              <Button
                label={staff ? "お客さん用に切り替える" : "店舗用に切り替える"}
                onPress={() => {
                  setStaff(!staff);
                  setMenu(false);
                }}
              />
              <Text style={s.sectionLabel}>お客さん側で表示する会員</Text>
              {data?.members.map((m) => (
                <Button
                  key={m.id}
                  variant="secondary"
                  disabled={busy}
                  label={`${m.nickname}${m.sample ? "（サンプル・9スタンプ開始）" : ""}${data.currentMemberId === m.id ? " ✓" : ""}`}
                  onPress={() => {
                    void pick(m.id)
                      .then(() => {
                        setMenu(false);
                        setMessage(`${m.nickname}さんの会員証を表示します。`);
                      })
                      .catch(() => {});
                  }}
                />
              ))}
              <Button
                label="新しいデモ会員を登録する"
                variant="secondary"
                disabled={busy}
                onPress={() => {
                  void run(() =>
                    repository.transact((d) => ({
                      ...d,
                      currentMemberId: null,
                    })),
                  )
                    .then(() => {
                      setStaff(false);
                      setTab("会員証");
                      setMenu(false);
                    })
                    .catch(() => {});
                }}
              />
              <Muted>
                サンプル会員は9スタンプで開始します。過去の使用済み・期限切れクーポンも確認できます。端末間の同期はありません。
              </Muted>
              <Button
                label="デモデータをリセット"
                variant="ghost"
                onPress={() => {
                  setMenu(false);
                  setResetting(true);
                }}
              />
              <Button
                label="閉じる"
                variant="secondary"
                onPress={() => setMenu(false)}
              />
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>
      <Modal
        transparent
        visible={resetting}
        animationType="fade"
        onRequestClose={() => {
          if (!busy) setResetting(false);
        }}
      >
        <View style={s.overlay}>
          <SafeAreaView style={s.modal}>
            <Heading>デモデータをリセットしますか？</Heading>
            <Muted>
              この端末の会員・スタンプ・特典・お知らせを削除し、最初のサンプルデータに戻します。
            </Muted>
            <Button
              label="リセットする"
              disabled={busy}
              loading={busy}
              onPress={() => {
                void run(() => repository.reset())
                  .then(() => {
                    setResetting(false);
                    setError(null);
                    setStaff(false);
                    setTab("ホーム");
                    setMessage("初期状態に戻しました。");
                  })
                  .catch(() => {});
              }}
            />
            <Button
              label="キャンセル"
              variant="secondary"
              disabled={busy}
              onPress={() => setResetting(false)}
            />
          </SafeAreaView>
        </View>
      </Modal>
      <Modal
        transparent
        visible={message !== null}
        animationType="fade"
        onRequestClose={() => setMessage(null)}
      >
        <View style={s.overlay}>
          <SafeAreaView style={s.modal}>
            <Text style={s.message}>{message}</Text>
            <Button label="閉じる" onPress={() => setMessage(null)} />
          </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: shop.colors.cream },
  app: {
    flex: 1,
    width: "100%",
    maxWidth: 560,
    alignSelf: "center",
    backgroundColor: shop.colors.cream,
  },
  header: {
    paddingHorizontal: 22,
    paddingVertical: 15,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderColor: shop.colors.line,
    gap: 8,
  },
  brand: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  mark: {
    width: 38,
    height: 38,
    borderWidth: 1,
    borderColor: shop.colors.green,
    borderRadius: 19,
    justifyContent: "center",
    alignItems: "center",
  },
  markText: { fontSize: 22, color: shop.colors.green, fontFamily: "serif" },
  brandName: {
    fontSize: 17,
    fontWeight: "600",
    color: shop.colors.ink,
    flexShrink: 1,
  },
  brandSub: { fontSize: 11, color: shop.colors.muted, marginTop: 3 },
  menuButton: {
    minHeight: 48,
    minWidth: 48,
    alignItems: "center",
    justifyContent: "center",
    padding: 8,
  },
  menuText: { fontSize: 12, color: shop.colors.green },
  dots: { fontSize: 14, letterSpacing: 2, color: shop.colors.green },
  body: { flex: 1 },
  loading: { padding: 28, gap: 22, flex: 1, justifyContent: "center" },
  tabs: {
    borderTopWidth: 1,
    borderColor: shop.colors.line,
    backgroundColor: shop.colors.white,
    flexDirection: "row",
    padding: 6,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 60,
    paddingVertical: 9,
    paddingHorizontal: 2,
    gap: 6,
    borderRadius: 12,
  },
  activeTab: { backgroundColor: shop.colors.pale },
  tabText: { fontSize: 12, color: shop.colors.muted },
  activeText: { color: shop.colors.green, fontWeight: "700" },
  staffFooter: {
    paddingHorizontal: 22,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderColor: shop.colors.line,
  },
  overlay: {
    flex: 1,
    backgroundColor: "#16251EBB",
    justifyContent: "center",
    alignItems: "center",
    padding: 18,
  },
  modal: {
    width: "100%",
    maxWidth: 480,
    maxHeight: "90%",
    backgroundColor: shop.colors.cream,
    borderRadius: 20,
    padding: 24,
    gap: 20,
  },
  sectionLabel: { fontSize: 16, fontWeight: "600", color: shop.colors.ink },
  message: { fontSize: 18, lineHeight: 28, color: shop.colors.ink },
});
