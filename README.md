# むさしの玉屋 会員アプリ

React Native・Expo SDK 58・TypeScriptのiPhone向け会員アプリです。本番接続用のアプリ、Firebase Authenticationによるログイン、Supabase PostgreSQL用のデータベースと管理APIを同梱しています。

**まず読む文書： [本番接続版の引継ぎ・Windowsでの準備手順](docs/PRODUCTION_HANDOVER.md)**

公開用の規約・データの取り扱いは、回答済みの保管方針を反映した[公開文書の最終確認案](docs/PUBLIC_DOCUMENTS_REVIEW.md)にまとめています。正式版として適用する前の案です。根拠と経過は[確認記録](docs/LEGAL_REVIEW.md)を参照してください。

Appleの管理画面へのアクセスとBundle ID登録まで進みました。[準備済みの資料と次の作業](docs/WAITING_FOR_APPLE.md)を参照してください。App Store掲載文案、バックアップ・復元、90日削除、ビルド用ファイルの整理を準備しています。

## 現在の状態

- 本番用のホーム・会員証・特典・お店は管理APIの情報を表示します。会員データはサーバーに保存します。
- メールとパスワード、メール確認、パスワード再設定、機種変更後の再ログイン、再認証付き退会があります。
- スタッフ権限はDBで確認し、スタンプ・特典・お知らせ・集計・オーナーの権限管理を行います。
- 旧デモは明示的に選んだときだけ動く、端末内の架空データです。本番会員や残高へ移行しません。
- 2026年11月4日更新：所有者のWindows画面でEASの変数作成成功と、production環境の`EXPO_IOS_BUNDLE_IDENTIFIER=jp.oneeight.tamaya.members`を確認しました。掲載名は「むさしの玉屋」、アイコンは店舗の正式ロゴへ変更する希望を受領しました。正式ロゴの画像は未提供で、現在の仮アイコンは差し替え前です。公開文書の最終案を準備し、正式反映・署名付きビルドはまだ行っていません。
- **所有者の操作で専用DBユーザー、RenderのAPI起動、会員登録から初回オーナー設定まで進んでいます。** 公開URLは`https://tamayaapp.onrender.com`で、所有者から`/health`が`status=ok`、`authMode=firebase`と表示されたとの報告を受けました。こちらの環境からRenderへの通信は制限され、直接の疎通確認はできていません。店舗情報の表示、499円での付与制限、500円での1スタンプ付与、同日の追加不可、会員証への反映に加え、2端末での会員QR読み取り、お知らせの追加・編集と別端末への反映も所有者の確認報告を受けています。再起動後のログイン保持、明示的な再ログイン、再設定メールの受信と新しいパスワードによる両端末の再ログインも所有者から成功報告を受けています。別のメールで登録した会員へのスタッフ権限の追加・停止と、停止後も通常の会員証を使えることも所有者の確認報告を受けています。次は公開用の規約・プライバシー表示、会員情報とバックアップの保管方針、正式なBundle IDとEAS・Appleの所有者設定を仕上げます。特典発行・交換の実機結果は未確認として記録しています。
- 2026年11月3日更新：所有者の11月2日のRender画面で`main`の`dd84795`が`Live`となり、その後の`/health`も`status=ok`・`authMode=firebase`との報告を受けました。スタッフ権限を停止済みの0スタンプのテスト用別会員について、iPhoneの「退会とアカウント削除が完了しました。」の画面と、削除後に同じメール・パスワードでログインできないとの報告を受けています。続けて所有者のApple管理画面で`Tamaya Members`／`jp.oneeight.tamaya.members`の登録を確認し、ソースのアプリ設定・公開設定例へ反映しました。所有者のPCとEAS環境への設定、証明書・署名付きビルドは次の手順です。
- 2026年11月1日、2台目のiPhoneとPCのSDK不一致を解消するためSDK 58へ更新し、所有者から更新後の起動・会員QR読み取りの成功報告を受けました。旧版のPCを更新する手順は[SDK更新手順](docs/PRODUCTION_HANDOVER.md#expo-goとアプリのsdkをそろえる)を参照してください。
- iPhoneの起動・登録などは所有者の操作報告として記録しています。こちらで直接実機を操作した確認や、全機能の実機検証が完了したとは報告していません。実施範囲は[検証結果](docs/VALIDATION.md)を参照してください。

## 正式ルールと設定

[正式な運用ルール](docs/OPERATING_RULES.md)と[サーバーの店舗設定](server/config/tamaya.json)を参照してください。

5スタンプで生菓子をランダムで1つ、発行から90日間有効です。500円以上のお会計が必要で、同じ会員への付与は日本時間で1日1回です。スタッフが確認した会計金額をサーバーで検証し、履歴へ記録します。レジとの自動連携は行いません。対象商品は生菓子・ギフト商品です。

店舗関係者からの提供情報として、住所は東京都中野区本町4-30-14、店舗電話は03-3381-7012、営業時間は10:00〜19:00、基本定休日は月曜日を設定しました。個別の商品名・商品一覧は表示しません。サービス運営者ワンエイトの問い合わせ先 `080-4909-7012` は店舗電話と分けています。

## 旧デモをもう一度見る場合

APIキー・有料契約を使わず、以前の端末内デモを起動できます。Windowsでは `package.json` があるフォルダーのアドレス欄へ `cmd` と入力してEnterを押します。黒い画面で1行ずつ実行してください。

```bat
npm ci
npm run start:demo -- --go --clear
```

iPhoneのExpo Goには、同じ黒い画面に出た起動用QRから接続します。同じWi-FiとExpoアカウントを使います。ブラウザーで見る場合は次を実行します。

```bat
npm run web:demo
```

デモは10スタンプ・100円引き・30日の**以前の仮条件**であり、正式ルールとは別です。保存は端末内だけで同期しません。デモメニューの切り替えは本番の認証ではありません。[旧デモのiPhone手順](docs/IPHONE.md)も参照できます。

`npm start` / `npm run web` は本番接続版を開きます。接続設定がない場合は準備画面を表示し、デモへ自動的には切り替わりません。

## 開発用のローカル連携確認

これは開発担当向けです。一般利用者のスマホにDockerやJavaは不要です。Node.js 24.3.0以上、Docker、Java 21以上、Chromiumが必要です。

```sh
npm ci
npm --prefix server ci
npm run local:setup
npm run local
```

起動完了後、**同じPC**で `http://localhost:8083` を開きます。Firebase認証エミュレーター、実際のPostgreSQL、API、Expoが動作します。実サービスには接続しません。架空の情報だけを使い、検証用の生菓子特典は本番で利用できません。`Ctrl+C`で終了すると検証DBも削除します。実機用の共有サーバーや常設サーバーの代わりではありません。

## 確認コマンド

```sh
npm run typecheck
npm test
npm --prefix server run typecheck
npm run test:server:postgres
npm --prefix server run build
npm run test:production:browser
npm run export:ios
npm run export:web
npm run production:check
```

`test:server:postgres` は専用のDocker PostgreSQLで同時操作と権限を確認します。`test:production:browser` は専用のローカル認証・DB・APIを起動し、Chromiumで実際の登録・店舗操作を確認します。ブラウザーがなければ `npx playwright install chromium` を先に実行してください。

`production:check` は正式公開前の不足を表示し、不足時に失敗します。設定未完了のまま配布することを防ぐための動作です。iOSのexportはコード生成の検査で、署名付きビルドや実機確認の代わりではありません。

## ファイルの場所

| 場所 | 内容 |
| --- | --- |
| `src/production` | Firebaseログイン、API接続、お客様・スタッフ画面 |
| `shared/contracts.ts` | アプリと管理APIで共有するデータ形式 |
| `server/src/production` | 本番用API、認証、PostgreSQL処理、初回準備コマンド |
| `server/supabase` | 非公開スキーマ、RLS、テーブル作成SQL |
| `server/config/tamaya.json` | 正式な店舗情報・特典・規約・問い合わせ文面 |
| `server/Dockerfile` / `deployment/render.yaml` | 常設サーバー用の配置設定 |
| `DemoApp.tsx` / `src/domain` / `src/storage` | 旧端末内デモ（本番では不使用） |
| `server/src`直下 / `server/public` | 以前のSQLite管理サーバーデモ |

本番用の秘密設定は `server/.env.production.example` を参考に用意します。アプリ用は直下の `.env.example` です。**DB接続情報やFirebase管理秘密鍵を、アプリ側の `EXPO_PUBLIC_*`、GitHub、チャットへ入れないでください。**

今後の公開は、実サービスへの接続・運用者の規約確認・実機での2端末確認後、[App Storeの手順](docs/APP_STORE.md)へ進みます。Apple Developer登録・署名・TestFlight送信・App Store申請・有料サービス契約は実施していません。
