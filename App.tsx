import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ProductionApp } from './src/production/ProductionApp';
import { createProductionRuntime } from './src/production/runtime';
import { Button, Heading, Muted, theme } from './src/ui';

let runtime: ReturnType<typeof createProductionRuntime> | undefined;
let configurationError: string | undefined;
if (process.env.EXPO_PUBLIC_APP_MODE !== 'demo') {
  try { runtime = createProductionRuntime(); }
  catch (error) { configurationError = error instanceof Error ? error.message : '接続設定を確認してください。'; }
}

export default function App() {
  if (process.env.EXPO_PUBLIC_APP_MODE === 'demo') {
    const DemoApp = require('./DemoApp').default as React.ComponentType;
    return <DemoApp />;
  }
  if (runtime) return <ProductionApp api={runtime.api} auth={runtime.auth} />;
  return <SafeAreaProvider><SafeAreaView style={s.safe}><ScrollView contentContainerStyle={s.content}>
    <Text style={s.brand}>むさしの玉屋</Text>
    <Heading>接続の準備が必要です</Heading>
    <Muted>{configurationError}</Muted>
    <View style={s.card}><Muted>データを端末内に仮保存して本番会員として扱うことはありません。設定完了後にアプリを開き直してください。</Muted></View>
  </ScrollView></SafeAreaView></SafeAreaProvider>;
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.cream },
  content: { padding: 24, paddingTop: 60, gap: 24, width: '100%', maxWidth: 560, alignSelf: 'center' },
  brand: { fontSize: 24, color: theme.green, fontWeight: '600' },
  card: { borderRadius: 18, backgroundColor: theme.white, padding: 22 },
});
