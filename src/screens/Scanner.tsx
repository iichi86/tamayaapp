import React from "react";
import { Text } from "react-native";
import { Button, Card, Muted } from "../ui";

export function Scanner({
  onScan,
  onClose,
}: {
  onScan: (raw: string) => void;
  onClose: () => void;
}) {
  return (
    <Card>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>
        カメラ読み取りについて
      </Text>
      <Muted>
        このブラウザのデモではカメラを使用しません。iPhoneのExpo
        Goで会員QRコードを読み取れます。1台で試す場合は「デモ会員を選択する」を使ってください。
      </Muted>
      <Button label="閉じる" onPress={onClose} variant="secondary" />
    </Card>
  );
}
