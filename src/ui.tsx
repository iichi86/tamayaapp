import React, { type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { shop } from './config/shop';

export const theme = {
  ...shop.colors,
  colors: shop.colors,
  radius: 22,
  danger: '#A14337',
};

type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  testID?: string;
};

export function Button({ label, onPress, variant = 'primary', disabled, loading, style, accessibilityLabel, testID }: ButtonProps) {
  const unavailable = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={unavailable}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: Boolean(unavailable), busy: Boolean(loading) }}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' ? styles.buttonPrimary : variant === 'secondary' ? styles.buttonSecondary : styles.buttonGhost,
        pressed && { opacity: 0.76 },
        unavailable && { opacity: 0.5 },
        style,
      ]}
    >
      {loading && <ActivityIndicator color={variant === 'primary' ? theme.white : theme.green} />}
      <Text style={[styles.buttonText, { color: variant === 'primary' ? theme.white : theme.green }]}>{label}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Heading({ children, eyebrow, style }: { children: ReactNode; eyebrow?: string; style?: StyleProp<TextStyle> }) {
  return (
    <View style={{ gap: 7 }}>
      {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
      <Text accessibilityRole="header" style={[styles.heading, style]}>{children}</Text>
    </View>
  );
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.muted, style]}>{children}</Text>;
}

export function Tag({ children, tone = 'green', style }: { children: ReactNode; tone?: 'green' | 'gold' | 'muted'; style?: StyleProp<ViewStyle> }) {
  const color = tone === 'gold' ? theme.gold : tone === 'muted' ? theme.muted : theme.green;
  return <View style={[styles.tag, { backgroundColor: tone === 'gold' ? '#F2EADB' : tone === 'muted' ? '#EEF0ED' : theme.pale }, style]}><Text style={[styles.tagText, { color }]}>{children}</Text></View>;
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.cream },
  content: { width: '100%', maxWidth: 1100, alignSelf: 'center', padding: 24, gap: 24, paddingBottom: 36 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  card: { backgroundColor: theme.white, borderRadius: theme.radius, padding: 24, borderWidth: 1, borderColor: '#E4E7DE', gap: 18 },
  title: { fontSize: 30, lineHeight: 42, fontWeight: '700', color: theme.ink, letterSpacing: 1.2 },
  heading: { fontSize: 24, lineHeight: 34, fontWeight: '700', color: theme.ink, letterSpacing: 0.8 },
  body: { fontSize: 17, lineHeight: 28, color: theme.ink },
  muted: { fontSize: 15, lineHeight: 25, color: theme.muted },
  eyebrow: { fontSize: 12, lineHeight: 20, fontWeight: '700', color: theme.green, letterSpacing: 2 },
  label: { fontSize: 15, lineHeight: 25, fontWeight: '600', color: theme.ink },
  divider: { height: 1, backgroundColor: theme.line },
  input: { minHeight: 54, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 12, borderWidth: 1, borderColor: theme.line, backgroundColor: theme.white, fontSize: 16, color: theme.ink },
  button: { minHeight: 50, paddingHorizontal: 20, paddingVertical: 14, borderRadius: 14, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10 },
  buttonPrimary: { backgroundColor: theme.green },
  buttonSecondary: { backgroundColor: theme.pale, borderColor: '#D2DDCF', borderWidth: 1 },
  buttonGhost: { backgroundColor: 'transparent', borderColor: theme.line, borderWidth: 1 },
  buttonText: { fontSize: 17, lineHeight: 26, fontWeight: '600', textAlign: 'center', flexShrink: 1 },
  tag: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  tagText: { fontSize: 12, lineHeight: 19, fontWeight: '600', letterSpacing: 0.3 },
  error: { fontSize: 15, lineHeight: 25, color: theme.danger },
});
