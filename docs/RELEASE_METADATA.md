# 掲載文と審査情報をPC内で準備する

更新日：2026年11月6日（日本時間）。対象は「むさしの玉屋」1.0.0、App Store ConnectのApp ID `6830628549`です。TestFlight版のインストール・ログイン・以前のスタンプ表示は、所有者から確認報告を受けています。掲載情報の同期は所有者の実行画面で成功を確認しました。App Review提出・一般公開は未実施です。

2026年11月5日、所有者のWindows画面で、掲載文・連絡先の保存とローカル検証の成功に続き、審査用一般会員の通常APIによる確認と、PC内の審査用ログイン設定の準備完了を確認しました。管理用JSONの選択まで完了しています。これは所有者の実行画面による確認で、開発側が秘密鍵を受領して本番へ接続した結果ではありません。両スクリプトを最初から再実行する必要はありません。次は[掲載画像](APP_STORE_SCREENSHOTS.md)とApple側の必須項目を整えます。掲載同期・審査提出はまだ実行していません。

## 11月6日：掲載情報の同期が成功

所有者のWindows画面で、EAS保存済みのApp Store Connect API Keyの利用、1.0.0のバージョン情報、日本語のバージョン・App情報、審査情報の作成・更新と、`Store configuration is synced with the app stores.`の成功文を確認しました。カテゴリ・年齢区分・App Clipは未設定としてスキップされています。これは所有者の実行画面による確認で、開発側がAppleのAPIへ接続した結果ではありません。

同期の再実行は不要です。次は[今回のApp Store Connect掲載画面](https://appstoreconnect.apple.com/apps/6830628549/appstore)を開き、実際の反映内容と画像・カテゴリ・年齢区分・プライバシー等の残る項目を確認します。成功した同期を、画像登録や審査提出・一般公開の完了とは扱いません。

以下の取得・同期コマンドは、今回完了した処理の参照用です。

## 自動で進める内容

2つのスクリプトを、所有者のWindows PCのアプリ直下で順番に使います。アプリ本体の再ビルドは不要です。

| スクリプト | 処理 |
| --- | --- |
| `scripts/prepare-store-metadata.mjs` | 検証済みの日本語掲載文とURLを取得し、不足する著作権・審査連絡先だけを入力。PC内の非公開設定を保存し、EASのローカル検証を実行 |
| `scripts/prepare-review-account.mjs` | 所有者がPC内で選択したFirebase管理用JSONを使い、審査専用の一般会員を作成。通常のログイン・会員登録APIを確認し、ログイン情報を同じ非公開設定へ保存 |

掲載文は[deployment/store.config.json](../deployment/store.config.json)と[掲載準備案](STORE_LISTING.md)にあります。連絡先・パスワード・秘密鍵は公開テンプレートへ追加しません。Appleへの同期・審査提出は、両スクリプトの処理に含まれません。

## Windowsでの実行

黒い画面で次の1行を実行します。取得先は検証済みコミットへ固定しています。

```bat
cd /d "%USERPROFILE%\Downloads\tamaya-server-setup\tamayaapp-main" && curl.exe -fL --retry 3 "https://raw.githubusercontent.com/iichi86/tamayaapp/ae36353c7e5ee8878c88a025a0930056183b5fc2/scripts/prepare-store-metadata.mjs" -o "scripts\prepare-store-metadata.mjs" && curl.exe -fL --retry 3 "https://raw.githubusercontent.com/iichi86/tamayaapp/ae36353c7e5ee8878c88a025a0930056183b5fc2/scripts/prepare-review-account.mjs" -o "scripts\prepare-review-account.mjs" && node scripts\prepare-store-metadata.mjs && node scripts\prepare-review-account.mjs --pick-credentials
```

最初のスクリプトで、次の情報だけをPCへ入力します。

1. 著作権表記。候補の`2026 ワンエイト`で正しければEnterを押します。
2. Apple審査の連絡先の姓、名、連絡を受け取れるメールアドレス。

確認済みのサービス窓口電話は国番号付きで設定します。既存の有効な連絡先は再入力せず保持します。保存済みの連絡先を変更するときは`node scripts\prepare-store-metadata.mjs --edit`を使います。

2つ目のスクリプトでは、ファイル選択画面で、以前用意したFirebase管理用JSONを選択します。JSONの本文や保存場所をチャットへ送る必要はありません。読み込みには、既に導入済みの`server/node_modules`のFirebase Admin SDKを使います。

正常終了すると、黒い画面に掲載設定の保存・ローカル検証と、審査用一般会員の準備完了が表示されます。ログイン用パスワードは画面へ出しません。通信が途中で切れた場合も、同じコマンドで再実行できます。既存の審査情報と一致しない場合は、上書きせず終了します。

## 非公開の保存先

| PC内のファイル | 保存するもの |
| --- | --- |
| `.env.store.config.json` | 掲載文、著作権、審査連絡先、審査用ログイン情報 |
| `.env.review-account.json` | 作成対象を識別し、途中から再実行するための記録と審査用ログイン情報 |
| `eas.json` | 公開先App IDと非公開設定ファイルの参照先。秘密情報の本文は入らない |

`.env*`の除外設定を確認してから書き込み、GitHubへの登録とEASビルドへの同梱を防ぎます。非公開ファイルには審査用パスワードが含まれます。共有・添付・公開リポジトリーへの移動は行いません。Firebase管理用JSON自体をこれらのファイルへコピーする処理はありません。

既存の連絡先・画像パス・他の設定は保持します。普段のオーナーや会員のパスワードを読み取る・変更する処理もありません。

## 作成する審査用会員の範囲

専用のランダムなUID・メール形式の識別子・パスワードを使い、一般会員を1件作成します。管理SDKでこの専用アカウントをメール確認済みに設定してから、通常のFirebaseログインと本番の会員登録APIを実行します。通常のお客様のメール確認要件は変更しません。

識別子は予約された`.invalid`ドメインを使い、外部メールは送りません。このアカウントでは確認メールの受信・パスワード再設定メールの受信を試験できません。「実際に確認メールを受け取って認証した会員」とは記録しません。審査メモへこの扱いを追記します。

新規会員は0スタンプ・特典なし・スタッフ権限なしです。購入や来店の記録、残高、特典、スタッフ権限を作り替えません。この会員だけでは特典詳細・交換やスタッフのカメラ・スタンプ付与の操作へ進めないため、残る機能の審査用の確認方法は提出前に別途整えます。

審査員が退会するとログインできなくなります。作成済みの認証アカウントが消えている場合、このスクリプトは自動再作成しません。退会処理や既存の削除ジョブと衝突しないよう、状況を確認して次の専用アカウントを用意します。

## Appleへの同期と提出

11月6日、同じ3画面を再受領し、画像の内容確認は済んでいます。チャットへの追加送信やZIP化を、この段階の条件にはしません。元画像の寸法は未確認で、Appleへの登録時にアップロード枠の判定と照合します。画像を登録済みとは扱いません。

EAS CLI 25.3.0の実装では、スクリーンショット未設定時は画像処理をスキップするため、掲載文・著作権・審査連絡先・ログイン情報を先に同期できます。カテゴリ未設定時も更新をスキップします。今回は初回1.0.0を対象とします。将来の更新では、未指定の段階的リリース設定が既存設定を削除する処理等も再確認し、このコマンドを無条件に流用しません。

所有者のWindows PCで次の1行を実行します。保存済みの私用設定を保持してローカル検証し、成功した場合にAppleへ同期します。現在の連絡先が有効なら再入力は求めません。必要なApple認証はPC内で行います。

```bat
cd /d "%USERPROFILE%\Downloads\tamaya-server-setup\tamayaapp-main" && set "EAS_NO_VCS=1" && set "EAS_PROJECT_ROOT=%USERPROFILE%\Downloads\tamaya-server-setup\tamayaapp-main" && set "DISABLE_EAS_ANALYTICS=1" && node scripts\prepare-store-metadata.mjs && npx eas-cli@25.3.0 metadata:push --profile production
```

`DISABLE_EAS_ANALYTICS=1`は、CLIのAPIエラー解析へ審査連絡先やデモログイン本文を送らないために設定します。`EXPO_NO_TELEMETRY`だけでEASの解析が無効になるとは扱いません。保存済みEASのApp Store Connect API Keyが利用できる場合は、それを使います。

CLIは同期失敗・一部成功でも終了コード0を返す場合があります。**`Store configuration is synced with the app stores.`という成功文と、Apple側の実際の表示**で確認します。エラーが出た場合はその部分を確認し、一部のみ更新された可能性も踏まえて続けます。

この作業環境から所有者のPCやApple管理画面を直接操作する接続はありません。今回の実同期は所有者のPCで成功表示を確認しました。Apple側の各入力欄の表示は、次に管理画面で照合します。同期は掲載情報の更新で、App Reviewへの審査提出・一般公開とは別です。EAS Metadataはbetaのため、Apple側の表示も照合します。

別に確認する項目は、Appのプライバシー、現行の年齢区分質問、カテゴリ、無料価格、配信先、権利情報、ビルド2の選択、審査用の確認方法、公開方法です。プライバシー申告の整理は[掲載準備案](STORE_LISTING.md#appのプライバシー申告用の整理)を使います。実際に表示されたApple側の項目と照合して進めます。

## 検証の範囲

公開テンプレートはEAS CLI 25.3.0のスキーマと、隔離環境の実`metadata:lint`で検証済みです。私用設定の保持、ローカル検証失敗時の復元、公開先の照合、審査用アカウントの対象限定・通常APIでの登録・途中失敗からの再実行、除外ルールの上書きや途中変更時の保護を含め、既存分と合わせたNodeテスト90件が成功しました。通信・認証SDKは検証用に注入しています。所有者のFirebase管理用JSONを使った本番での審査用会員作成や、Appleへの掲載同期を開発側で実施した結果ではありません。
