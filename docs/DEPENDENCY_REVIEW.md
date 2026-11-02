# 依存ライブラリの確認

確認日：2026年11月2日。npmの公開監査結果と、このアプリで使う経路を照合した記録です。全機能の安全性や、未報告の問題がないことを保証する資料ではありません。

| 対象 | 結果と範囲 |
| --- | --- |
| アプリ側の導入ツリー | high 4、moderate 11、critical 0 |
| サーバーの実行依存をロックファイルで確認 | moderate 6、high・critical 0 |
| 未使用のoptional依存を除いたサーバー実行ツリー | 報告0件 |
| 今回作成した最終Dockerイメージ | 報告0件。実際のイメージの依存と監査結果を確認 |

アプリのhigh 4件は、利用していないFirestoreを経由する`@grpc/grpc-js@1.9.16`に関係します。主要な勧告は[GHSA-m9gg-hp2v-232j](https://github.com/advisories/GHSA-m9gg-hp2v-232j)です。アプリの実装は`firebase/app`と`firebase/auth`を読み込み、Firestoreの機能は使用していません。moderateの報告には、Expoの開発・ビルドツールを経由するglob/minimatchが含まれます。導入ツリーの報告を解消済みとは扱っていません。

サーバーの6件は、Firebase Adminの未使用のoptionalなFirestore等を経由します。実装は`firebase-admin/app`と`firebase-admin/auth`を使います。Dockerのビルド後に`npm prune --omit=dev --omit=optional`を行い、不要なFirestore・Storage等を実行イメージから除外しました。マニフェストやロックファイル自体は変更していません。

この構成で、実際のDockerイメージを使い、ローカル認証エミュレーターとPostgreSQLに接続して確認しました。

- 非rootのUID 1000で起動し、ヘルスチェックが成功。
- 実際のFirebase Admin SDKによる確認済みの架空ユーザー操作が成功。
- 会員登録、会員情報、会員QR、退会完了、退会後の古いJWTの401拒否が成功。
- PostgreSQLの接続ロールはsuperuser・RLS回避権限なし。
- イメージ内のコンパイル結果と確認中のソース、プライバシー文面の版が一致。
- ローカル検証用の接続設定、プロキシ設定や証明書の上書きを実行イメージへ残していないことを確認。

実Firebase・Supabase・Renderでの新しいイメージの動作は、所有者の環境へ反映した後に確認します。ローカルのテスト用コンテナ・認証エミュレーター・一時ファイルは終了・削除しました。

今回の互換系列では、通常の互換パッチ更新による解消を確認できませんでした。npmが示す古いExpoやFirebaseへの大きなダウングレードを、そのまま適用する対応にはしていません。今後の修正版と、最終的なアプリのSDK構成に基づく再評価が残ります。
