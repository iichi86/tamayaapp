import React, { useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Button, Card, Muted } from "../ui";

export function Scanner({
  onScan,
  onClose,
}: {
  onScan: (raw: string) => void;
  onClose: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const captured = useRef(false);
  if (error)
    return (
      <Card>
        <Text style={s.title}>カメラを開けませんでした</Text>
        <Muted>{error}</Muted>
        <Button label="閉じる" onPress={onClose} variant="secondary" />
      </Card>
    );
  if (!permission?.granted)
    return (
      <Card>
        <Text style={s.title}>カメラの許可</Text>
        <Muted>
          会員QRコードの読み取りにだけ使用します。録画・撮影や写真の保存はしません。
        </Muted>
        <Button
          label="カメラの使用を許可"
          disabled={permission?.canAskAgain === false}
          onPress={() => {
            void requestPermission().catch(() => setError('iPhoneの設定でカメラの許可を確認してください。デモ会員の選択でも操作を試せます。'));
          }}
        />
        <Button label="閉じる" onPress={onClose} variant="secondary" />
        {permission && !permission.canAskAgain && (
          <Muted>
            許可できない場合は、iPhoneの「設定」からExpo
            Goのカメラを許可してください。
          </Muted>
        )}
      </Card>
    );
  return (
    <View style={{ gap: 12 }}>
      <Text style={s.title}>会員証のQRコードを枠内へ</Text>
      <View style={s.camera}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          onMountError={() => setError('カメラを使用できません。ほかのアプリを閉じてお試しください。デモ会員の選択でも操作できます。')}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => {
            if (!captured.current) {
              captured.current = true;
              onScan(data);
            }
          }}
        />
      </View>
      <Muted>
        読み取り後に会員を確認します。読み取りだけではスタンプは付きません。
      </Muted>
      <Button label="読み取りを閉じる" onPress={onClose} variant="secondary" />
    </View>
  );
}
const s = StyleSheet.create({
  title: { fontSize: 20, fontWeight: "600" },
  camera: { height: 290, borderRadius: 16, overflow: "hidden" },
});
