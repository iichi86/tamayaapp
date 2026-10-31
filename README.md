# むさしの玉屋 会員アプリ

React Native・Expo SDK 57・TypeScriptのiPhone向け会員アプリです。本番接続用のアプリ、Firebase Authenticationによるログイン、Supabase PostgreSQL用のデータベースと管理APIを同梱しています。

**まず読む文書： [本番接続版の引継ぎ・Windowsでの準備手順](docs/PRODUCTION_HANDOVER.md)**

## 現在の状態

- 本番用のホーム・会員証・特典・お店は管理APIの情報を表示します。会員データはサーバーに保存します。
- メールとパスワード、メール確認、パスワード再設定、機種変更後の再ログイン、再認証付き退会があります。
- スタッフ権限はDBで確認し、スタンプ・特典・お知らせ・集計・オーナーの権限管理を行います。
- 旧デモは明示的に選んだときだけ動く、端末内の架空データです。本番会員や残高へ移行しません。
- **所有者のPCで専用DBユーザーを作成し、Renderの管理APIを起動するところまで進んでいます。** 公開URLは`https://tamayaapp.onrender.com`で、所有者から`/health`が`status=ok`、`authMode=firebase`と表示されたとの報告を受けました。こちらの環境からRenderへの通信は制限されており、直接の疎通確認はできていません。実Firebaseの会員登録・ログイン、初回オーナー登録、2端末の業務操作、一般公開の準備はこの後です。
- 今回の本番接続版をiPhone実機で確認したとは報告していません。実施範囲は[検証結果](docs/VALIDATION.md)を参照してください。

## 正式ルールと設定

[正式な運用ルール](docs/OPERATING_RULES.md)と[サーバーの店舗設定](server/config/tamaya.json)を参照してください。

5スタンプで生菓子をランダムで1つ、発行から90日間有効です。500円以上のお会計が必要で、同じ会員への付与は日本時間で1日1回です。スタッフが確認した会計金額をサーバーで検証し、履歴へ記録します。レジとの自動連携は行いません。対象商品は生菓子・ギフト商品です。

併用など回答待ちの条件がある間は、設定の `operationsEnabled` を無効にして誤った条件で運用を開始しません。住所・店舗電話は裏付けを取得できるまで未設定です。サービス運営者ワンエイトの問い合わせ先 `080-4909-7012` は店舗電話と分けています。

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

これは開発担当向けです。一般利用者のスマホにDockerやJavaは不要です。Node.js 24以上、Docker、Java 21以上、Chromiumが必要です。

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
