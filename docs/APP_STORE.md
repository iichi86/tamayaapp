# Windowsから「むさしの玉屋」をApp Storeで公開するまで

この手順書の目標は、お客様がApp Storeで玉屋のアプリを見つけ、無料でインストールして使える状態にすることです。Expo Go内で試作を開くこととは、作業が異なります。Windowsからでも、ExpoのEAS Buildというクラウド上の仕組みでiPhoneアプリを作れます。

**今回の作業範囲は、App Storeでの一般公開までです。** 11月4日の所有者の依頼に基づき、署名付きビルド、TestFlight、掲載情報、審査、公開の順に進めます。現在行う操作と役割は[公開までの段階別手順](RELEASE_STEPS.md)を参照してください。この作業環境からTestFlight送信・App Store申請や新たな有料契約はまだ実行していません。

2026年11月4日、所有者のWindows画面で、署名付きiOSアプリの`Build finished`と`Submitted your app to Apple App Store Connect!`、アップロード成功の表示を確認しました。対象はバージョン`1.0.0`・ビルド番号`2`で、App Store ConnectのApp IDは`6830628549`です。Apple側で処理中と案内されており、[TestFlightの対象画面](https://appstoreconnect.apple.com/apps/6830628549/testflight/ios)で処理状況を確認する段階です。こちらがAppleやEASへ直接接続して照会した結果ではありません。TestFlightでのビルド表示・iPhoneへのインストール、App Review提出、一般公開はまだ確認していません。今回のビルド・アップロードをやり直す必要はありません。

次は[現在のTestFlight手順](RELEASE_STEPS.md#今はappleの処理を確認する)へ進みます。以下は、今回のアップロード成功前の準備経過を含む手順書です。

2026年11月4日更新：Apple側の`Tamaya Members`／`jp.oneeight.tamaya.members`の登録に加え、所有者の画面でEASのproduction環境への同じBundle IDの追加成功と、10項目の一覧を確認しました。表示された8項目の値は公開接続設定と一致し、`EAS_PROJECT_ID`・`RELEASE_BUSINESS_APPROVED`の2項目はSensitiveで伏せられているため実値を再確認したとは扱いません。PCの`.env`保存結果とExpoの最終設定は未確認で、次のビルド準備時に照合します。これらは所有者の画面による確認で、開発側が外部アカウントへ接続して照会した結果ではありません。証明書・署名付きビルド・App Store Connectのアプリ作成・TestFlight送信は未実施です。

11月4日、運営者から「文面OK」と明示の承認を受け、[確認済みの公開文書](PUBLIC_DOCUMENTS_REVIEW.md)の3本文を店舗設定へ正式反映しました。利用規約・プライバシーポリシーの版は`2026-11-04-1`で、リポジトリーの配布承認フラグは`1`です。既存会員の旧版への同意記録は上書きしていません。受領した正式ロゴを基にしたアイコンもリポジトリーへ反映しました。次は[今回のWindows更新手順](#今回のwindows環境を更新する)で最新ビルド入力とPC・EASの承認フラグを更新し、最終設定を照合して署名付きビルドへ進みます。これらのWindows・EAS側の更新と、Render上の正式本文への切替は未確認です。準備資料は[作業一覧](WAITING_FOR_APPLE.md)、掲載文案は[App Store掲載準備](STORE_LISTING.md)にまとめています。

2026年11月1日までに、所有者からFirebase・Supabase・Renderへの接続、SDK 58更新後のiPhone起動、会員登録、基本的なスタンプ付与、2端末の会員QR読み取り、お知らせの追加・編集、ログイン保持・再ログイン・パスワード再設定、スタッフ権限の追加・停止について成功報告を受けています。こちらが実機や公開APIを直接操作した確認ではありません。署名付きビルド・TestFlight・Appleへの申請は未実施です。実施済みと未確認の範囲は[検証結果](VALIDATION.md)を参照してください。

公開全体の作業順は、**運営名義を決める → 本番機能を実装する → 必要な素材をそろえる → Appleの登録状況を確認する → アプリをビルドする → TestFlightで確認する → ストア情報を入力する → 審査 → 公開**です。配布前の設定・正式条件の確認を終えてから、公開用の本番接続版を提出します。

## 1．誰の名義で公開するかを決める

最初に、アプリの運営者と、Apple Developer Programを利用する名義を決めます。店舗の正式な運営者と相談し、**その名義ですでに登録済みか**を確認します。登録済みなら、今回使うApple Account・チーム・権限を確認して既存の登録を使います。未登録の場合に、新規登録の名義と契約内容を検討します。

今回の所有者からは、2026年11月1日に「ワンエイトは個人事業」「Apple Developer Programは未登録」との回答を受けています。公開文書は[確認案](LEGAL_REVIEW.md)に整理しています。Expoアカウントの確認・EASプロジェクトの作成は、Appleへの支払い前に進められます。

| 登録方法 | 先に確認すること |
| --- | --- |
| 個人として登録 | App Storeの販売元には、通常、登録者の法的な個人名が表示されます。店名を入力するだけで販売元を屋号にできるわけではありません。 |
| 組織として登録 | 法的な組織としての要件、登録する人の権限、D‑U‑N‑S番号などを確認します。個人事業主が必ず組織登録できるとは限りません。 |

アプリの表示名は「むさしの玉屋」にできますが、表示名と販売元の名義は別です。登録後に名義を変更する作業を避けるため、ここを先に決めます。

Apple Developer Programは、通常**年額99米ドル、または現地通貨相当額**の有料登録です。日本での請求額、税金、更新条件は、実際のAppleの登録画面で確認してください。無料のApple Accountだけでは、一般公開用の配布はできません。

Expoアカウントは無料で作成できます。EAS Buildには無料枠がありますが、回数・待ち時間・対象などの条件は変わります。[Expoの料金画面](https://expo.dev/pricing)を確認してください。有料プランを選択・契約する操作は、この手順では自動実行しません。

## 2．本番サービスへの接続を終える

[本番接続版の引継ぎ](PRODUCTION_HANDOVER.md)に従って、Firebase・Supabase・常設サーバーを用意します。今回の所有者の環境では準備が進み、公開URLの`/health`と、実iPhoneからの認証・業務操作の成功報告を受けています。準備済みのプロジェクトや会員・権限を作り直す必要はありません。

正式条件は500円以上のお会計で1日1スタンプ、5個でランダムの生菓子1つ、90日有効、交換時の追加購入不要、他の割引との併用可です。店舗スタッフが生菓子を選んでお渡しします。

配置後の確認結果は[検証結果](VALIDATION.md)へ記録します。確認済みの操作を理由なく繰り返す必要はありません。確認用別会員の退会完了と削除後のログイン拒否は所有者の実機画面・報告で確認済みです。特典の実機での発行・交換は未確認として明記し、ローカルの認証エミュレーターやChromiumでの成功を実機確認済みとは扱いません。

公開版では `EXPO_PUBLIC_APP_MODE=production` を使用します。デモメニューによるスタッフ切り替えや架空の会員は使いません。`npm run production:check` が不足を表示する間は配布へ進みません。

## 3．店舗情報、公開する文章、画像をそろえる

次のものを用意します。未提供の情報を仮の事実として埋めないでください。

- 正式な運営者名、住所、営業時間、電話番号など、掲載する店舗情報。
- 商品名・商品一覧は掲載しない方針です。写真などを今後追加する場合は、使用できる素材を用意します。
- 実店舗で承認されたスタンプ・クーポン条件。対象商品、併用、期限など。
- 問い合わせ先のメールアドレスと、ブラウザーで開けるサポートページのURL。
- プライバシーポリシーのURL。アプリ内からも開けるようにします。
- App Storeに掲載する説明文、検索用キーワード、正式なアプリアイコン。

本番の店舗情報・正式条件・公開文書は `server/config/tamaya.json` にあります。配色は `src/config/shop.ts`、接続設定は直下の `.env.example` を参照してください。

利用規約・プライバシーポリシー・サポートページの本文は、[確認済みの公開文書](PUBLIC_DOCUMENTS_REVIEW.md)を基に運営者の承認を受け、店舗設定へ正式反映しました。提供事業者の未確認のログ保存日数は推測で埋めず、各社の保存・削除条件に従う旨を記載しています。全ログの固定日数の確認やSupabase Proへの先行変更を、文面作成・署名準備の一律の前提にはしていません。バックアップの取得担当・保管先・期間は、実際のお客様の運用開始前に決めます。

### アプリアイコン

旧仮アイコンとして、「玉」の文字と深緑の円を使う1024×1024の不透明PNGを作成し、`app.config.ts`から`assets/app-icon.png`を参照する設定を用意しました。

11月4日、所有者が掲載名を「むさしの玉屋」、アイコンを店舗の正式ロゴへ変更することを選択し、生成りの背景に赤い店印のロゴ画像を添付しました。この画像を基に画像生成ツールで用意した1254×1254の不透明PNGを`assets/app-icon.png`へ反映しました。原本と同一のピクセルであるという扱いにはしていません。Expo SDK 58の実際のiOSアイコン生成処理で、1024×1024の全ピクセルが不透明なAppIconを生成できることを確認しています。Windows側への反映は未確認です。設定は `npx expo config --json` で確認できます。

## 4．Apple Developer Programへ登録する

今回の所有者は登録手続きを進め、11月3日にIdentifiersへアクセスして下記のApp IDを登録できました。新規登録手順の再実施は不要です。以下は登録前の参考手順です。個人登録では通常、App Storeの販売元に法的な氏名が表示されます。契約の金額・更新条件は所有者が公式画面で確認します。

まず、予定する公開名義で登録済みかを確認します。登録済みなら[Apple Developerのアカウント画面](https://developer.apple.com/account/)で利用できるチーム・権限を確認し、以下の新規登録手順は省きます。未登録で、本番化と公開方針が決まった場合に公式の[登録案内](https://developer.apple.com/programs/enroll/)を開きます。新規の有料契約は、所有者が名義・料金・更新条件を確認して選びます。

1. 手順1で決めた運営者のApple Accountを用意します。2ファクタ認証が使える状態にします。
2. 公式案内から登録を開始します。個人・組織のどちらで登録するかを確認します。
3. 正式な名前、住所、連絡先などを入力します。組織登録では、組織の確認情報も必要になります。
4. 申込内容、請求額、更新条件を読み、契約する場合に自分で手続きします。
5. 登録完了の通知を待ち、[App Store Connect](https://appstoreconnect.apple.com/)に入れることを確認します。申込直後にすべて使えるとは限りません。

本人確認や追加書類を求められたら、Appleの公式画面で対応してください。パスワード、認証コード、本人確認書類を、このチャットへ送る必要はありません。

## 5．アプリの識別子を確認し、App Store Connectに登録する

アプリの内部の識別子を**Bundle ID**と呼びます。今回の登録値は **`jp.oneeight.tamaya.members`** です。リポジトリーの`app.json`と設定例をこの値にそろえ、11月4日にはEASのproduction環境への追加も所有者の画面で確認しました。所有者のPCの`.env`保存結果と最終的に解決される設定は、ビルド準備時に照合します。

11月3日の所有者のIdentifiers一覧に、名前`Tamaya Members`、識別子`jp.oneeight.tamaya.members`が表示されました。候補段階を終え、今回のアプリではこの登録値を使用します。`app.config.ts`が環境変数を最終的なiOS識別子へ反映するため、Windowsの最新ビルド入力をそろえた後、`npx expo config --json`の`ios.bundleIdentifier`を確認します。使い始めたあとで変えると別のアプリとして扱われます。

### 登録済みBundle IDをPCとEASへ反映する

11月4日、所有者の画面で`Created variable EXPO_IOS_BUNDLE_IDENTIFIER on project @oneight/tamaya-members-demo.`と、一覧の`EXPO_IOS_BUNDLE_IDENTIFIER=jp.oneeight.tamaya.members`を確認しました。EAS側の登録は完了済みです。以下は実施した操作の記録で、`env:set`の再実行は不要です。PCの保存結果はビルド準備時に最終設定と照合します。

所有者のWindows側で、これまで使っているアプリ直下へ移動します。

```bat
cd /d "%USERPROFILE%\Downloads\tamaya-server-setup\tamayaapp-main"
```

ZIPで用意したPCでは、同じ黒い画面で次を設定します。別の黒い画面を開いた場合は、その画面でも設定します。

```bat
set "EAS_NO_VCS=1"
set "EAS_PROJECT_ROOT=%CD%"
```

`.env`をメモ帳で開きます。

```bat
notepad .env
```

既存の`EXPO_IOS_BUNDLE_IDENTIFIER=`の行を、`EXPO_IOS_BUNDLE_IDENTIFIER=jp.oneeight.tamaya.members`へ置き換えて保存します。行がない場合は1行追加します。同じ設定名を重複させたり、他の接続設定を消したりしません。ファイル名は`.env`のまま保存し、`.env.txt`にはしません。

同じ黒い画面で、EASのproduction環境へこの1項目を追加・更新します。

```bat
npx eas-cli@25.3.0 env:set production --name EXPO_IOS_BUNDLE_IDENTIFIER --value jp.oneeight.tamaya.members --visibility plaintext --scope project --non-interactive
```

登録した値を一覧で確認します。

```bat
npx eas-cli@25.3.0 env:list production
```

`EXPO_IOS_BUNDLE_IDENTIFIER=jp.oneeight.tamaya.members`が表示されることを確認します。この識別子は公開設定として扱えます。CLI 25.3.0のヘルプと公開ソースで、この`env:set`が作成・更新に対応し、上記フラグが利用できることを確認しています。既存のプロジェクト連携を利用するため、`eas init`やアプリ・認証アカウントの作り直しは不要です。`RELEASE_BUSINESS_APPROVED`の値はこの操作では変更しません。

### Apple側にBundle IDを登録する

今回の登録は完了済みです。以下は参照用で、同じApp IDを作り直す手順には進みません。登録時はApp IDs→App、Descriptionは`Tamaya Members`、Bundle IDはExplicitを選択しました。現在のメール・パスワード認証と会員QR読み取りの実装では、Capabilitiesを追加する必要はありません。

1. [Apple Developerのアカウント画面](https://developer.apple.com/account/)に入ります。
2. 「Certificates, Identifiers & Profiles」から「Identifiers」を開き、追加操作を選びます。
3. App IDを作成する手順へ進み、アプリ用の識別子を登録します。
4. 説明にはアプリを判別できる名前、Bundle IDには`EXPO_IOS_BUNDLE_IDENTIFIER`へ設定した同じ値を入力します。
5. 内容を確認して登録します。不要な機能をまとめて有効にする必要はありません。本番の認証・通知などで必要な機能がある場合は、その実装に合わせます。

### App Store Connectにアプリの枠を作る

今回の標準手順では、第10節のEAS提出処理からアプリの枠を準備します。`eas.json`へ掲載名・日本語・SKU・Bundle IDを設定済みで、初めから同じ値をブラウザーで手入力する必要はありません。以下は、自動準備を使えない場合の参考手順です。

1. [App Store Connect](https://appstoreconnect.apple.com/)の「マイApp／Apps」を開きます。
2. 追加の「＋」から「新規App／New App」を選びます。
3. プラットフォームは「iOS」を選びます。
4. 名前は、公開する正式なアプリ名を入力します。使用済みなどの案内が出た場合は、表示された条件に従って調整します。
5. 主言語は「日本語」を選びます。
6. Bundle IDは、上で登録した同じ識別子を選びます。
7. SKUには、内部管理用の識別名を入力します。未使用なら`tamaya-members-ios`などを使えます。SKUはお客様向けの表示名ではありません。
8. 作成を確定し、アプリの管理画面が開けることを確認します。

AppleやExpoの画面は更新されます。ここに書いた日本語・英語の名称と多少異なる場合は、同じ意味の項目を確認してください。

## 6．Windowsで、公開作業に使う最新版のソースを用意する

### 今回のWindows環境を更新する

今回の一括準備・署名付きビルド・Appleへのアップロードは成功済みです。以下は必要なときの参照用で、同じコマンドを再実行する必要はありません。現在の操作は[Appleの処理確認とTestFlight](RELEASE_STEPS.md#今はappleの処理を確認する)です。

今回使用した[一括準備コマンドの記録](RELEASE_STEPS.md#完了した段階12の一括操作参照用)には、6ファイル取得、必要な環境設定、配布前チェック、公開サーバーの確認、ビルドと成功後のTestFlightアップロードをまとめています。以下はビルドまでの処理を個別に行う場合の参考です。一括処理を使った後に、同じ取得操作を繰り返す必要はありません。

所有者のPCではSDK 58の依存を導入済みです。今回は6ファイルと承認フラグを更新するため、`npm ci`で部品を入れ直す必要はありません。以下のコマンドを1つずつ実行し、エラーが出た場合はその表示を確認してから続けます。PCの`.env`全体やサーバーの秘密設定は上書きしません。

アプリ直下へ移動します。

```bat
cd /d "%USERPROFILE%\Downloads\tamaya-server-setup\tamayaapp-main"
```

今回検証したコミットから、ビルドに使う6ファイルを既存の保存先へ更新します。取得元を固定して、同じ版の文面・ロゴ・ビルド設定をそろえます。

```bat
curl.exe -fL --retry 3 "https://raw.githubusercontent.com/iichi86/tamayaapp/69d52e93543f7d4946b3ddd15de8d8a1b34827f0/app.json" -o app.json
```

```bat
curl.exe -fL --retry 3 "https://raw.githubusercontent.com/iichi86/tamayaapp/69d52e93543f7d4946b3ddd15de8d8a1b34827f0/app.config.ts" -o app.config.ts
```

```bat
curl.exe -fL --retry 3 "https://raw.githubusercontent.com/iichi86/tamayaapp/69d52e93543f7d4946b3ddd15de8d8a1b34827f0/.easignore" -o .easignore
```

```bat
curl.exe -fL --retry 3 "https://raw.githubusercontent.com/iichi86/tamayaapp/69d52e93543f7d4946b3ddd15de8d8a1b34827f0/eas.json" -o eas.json
```

```bat
curl.exe -fL --retry 3 "https://raw.githubusercontent.com/iichi86/tamayaapp/69d52e93543f7d4946b3ddd15de8d8a1b34827f0/server/config/tamaya.json" -o "server\config\tamaya.json"
```

```bat
curl.exe -fL --retry 3 "https://raw.githubusercontent.com/iichi86/tamayaapp/69d52e93543f7d4946b3ddd15de8d8a1b34827f0/assets/app-icon.png" -o "assets\app-icon.png"
```

既存の`.env`を開きます。

```bat
notepad .env
```

`RELEASE_BUSINESS_APPROVED`の既存行だけを`RELEASE_BUSINESS_APPROVED=1`へ変更して保存します。すでに`1`ならその値を保持します。他の接続設定や`EXPO_IOS_BUNDLE_IDENTIFIER=jp.oneeight.tamaya.members`の行は保持します。

同じ黒い画面で、ZIP利用時のEAS設定を行います。

```bat
set "EAS_NO_VCS=1"
```

```bat
set "EAS_PROJECT_ROOT=%CD%"
```

今回の文面承認に基づき、EASのproduction環境も承認済みへ更新します。Bundle IDや他の登録済み接続設定は再登録しません。

```bat
npx eas-cli@25.3.0 env:set production --name RELEASE_BUSINESS_APPROVED --value 1 --visibility sensitive --scope project --non-interactive
```

配布前の設定を確認します。

```bat
npm run production:check
```

すべて成功してから、署名付きiOSアプリのビルドへ進みます。Appleへのログイン・証明書等の案内は[第9節](#9署名付きのiphoneアプリをクラウドで作る)を参照します。

```bat
npx eas-cli@25.3.0 build --platform ios --profile production
```

この手順ではビルドまで進め、TestFlight・App Storeへの送信は行いません。

開発側では、iOS向けのproduction exportと配布前チェックが成功しています。実際のEAS CLI 25.3.0のアーカイブ処理で新しいアイコンと正式な店舗設定が入り、`.env`・サーバー本体・文書・deploymentファイルが除外されること、アーカイブ内でもproductionの公開設定を使った配布前チェックが成功することを確認しました。所有者のWindowsでの更新・EASリモートの承認フラグ更新・署名付きクラウドビルドの成功とは分けて記録します。

### 初回導入時の参考手順

**本番化が済んだ最新版のファイル一式**を使います。以前ダウンロードした端末内デモのまま、設定ファイルだけを足しても、本番機能は追加されません。ソースの受け取り・更新が済んでから以下へ進みます。

1. いま開発サーバーを動かしている黒い画面があれば、画面内をクリックして`Ctrl + C`で止めます。終了確認が出たら`y`を入力してEnterを押します。
2. 黒い画面がなければ、Windowsキーを押しながら`R`を押し、`cmd`と入力してEnterを押します。
3. 次の1行を貼り付けてEnterを押します。これは、これまで確認できた保存先です。最新版を別の場所に置いた場合は、その`package.json`が入っているフォルダーへ移動します。

   ```bat
   cd /d "%USERPROFILE%\Downloads\tamaya-server-setup\tamayaapp-main"
   ```

4. 必要な部品が未導入、または依存設定が変わった場合は次を実行します。同じSDK 58版の部品を導入済みなら、ここで入れ直す必要はありません。処理が終わり、`C:\Users\...>`の入力行に戻るまで待ちます。

   ```bat
   npm ci
   ```

5. 次を1行ずつ実行します。失敗した場合はビルドへ進まず、表示された問題を修正します。

   ```bat
   npm run typecheck
   ```

   ```bat
   npm test
   ```

このプロジェクトで確認したNode.jsは24.19.0で、SDK 58版の最低要件は24.3.0です。EAS CLIはこの手順では**25.3.0**を明示します。設定の読み取りは確認していますが、SDK 58版の署名付きクラウドビルドはまだ成功を確認していません。Expo SDKの更新コマンドではないので、これによってSDK 58を別のSDKへ変更するわけではありません。

## 7．Expoへログインし、EASプロジェクトを作る

各コード枠の1行をコピーし、黒い画面へ`Ctrl + V`で貼り付けて、Enterを押します。途中で追加ツールのインストール確認`Ok to proceed?`が出た場合は、`y`を入力してEnterを押します。

```bat
npx eas-cli@25.3.0 login
```

Expoアカウントのメールアドレスまたはユーザー名と、パスワードでログインします。すでにログイン済みと表示される場合は、そのアカウントが今回使うものか確認します。次でユーザー名を確認できます。

```bat
npx eas-cli@25.3.0 whoami
```

### ZIPを展開したフォルダーを使っている場合

今回のようにZIPを展開して使っており、Gitで管理していない場合は、先にソース一式のバックアップを別フォルダーへ残します。続けて、同じ黒い画面で次を1行ずつ実行します。

```bat
set "EAS_NO_VCS=1"
```

```bat
set "EAS_PROJECT_ROOT=%CD%"
```

これは、このコマンドプロンプトでEASを使うための設定です。画面を閉じると設定もなくなります。別の日に新しい黒い画面を開いて作業を再開するときは、アプリのフォルダーへ移動してから同じ2行を実行します。

Gitでソースを管理している場合は、この2行は不要です。通常のGit管理を続け、作業内容を保存した状態でEASを使います。ZIP利用の方が、このためだけにGitの操作を覚え直す必要はありません。

### Expo上のプロジェクトを作る

2026年11月2日、所有者のWindows画面でEAS CLIへのログイン成功と、利用できるアカウントに対するOwner権限を確認しました。今回の作成先はログイン中の`oneight`を指定します。

Windowsの古いZIPを使っている場合は、先に開発担当が案内する修正版の`app.config.ts`へ更新します。修正版は、EASが保存した`app.json`のProject ID・所有者を読み直し、`.env`の公開設定も読み込みます。EASから渡された環境変数は優先して保持します。

今回の更新コマンドは、アプリ直下の黒い画面で次の1行です。取得がエラーになったら次へ進まず、その表示を確認します。

```bat
curl.exe -fL --retry 3 "https://raw.githubusercontent.com/iichi86/tamayaapp/4cc580522562fc73ad4113dae062d8a570aa28a6/app.config.ts" -o app.config.ts
```

前のZIP用の2つの`set`を同じ画面で実行してから、次を実行します。

```bat
npx eas-cli@25.3.0 init --account oneight
```

`@oneight/tamaya-members-demo`を新規作成する確認、または同じ名前の既存プロジェクトへ連携する確認が出た場合は、内容を確認して進めます。`(Y/n)`の形式なら`y`を入力してEnterを押します。`--force`で既存の連携を上書きする手順にはしていません。

修正版の動的設定は、EASが`app.json`へ保存するProject IDと所有者を取り込みます。完了したら、次でプロジェクト名と実際のUUIDを確認します。

```bat
npx eas-cli@25.3.0 project:info
```

自動保存でエラーが出た場合は、新しいプロジェクトを何度も作成せず、その画面から連携結果を確認します。作成済みのIDが必要な場合は、`node -p "require('./app.json').expo.extra?.eas?.projectId"`でローカルに保存された値を確認できます。確認できた実UUIDをPCの`.env`の`EAS_PROJECT_ID`とEASのproduction環境へそろえます。**適当なIDは作らないでください。**

`.env` はGitHubへ公開しません。EASクラウドビルドではPCの `.env` に依存せず、Expoの対象プロジェクト → Environment variables → production環境へ、`.env.example` の公開接続設定、`EXPO_IOS_BUNDLE_IDENTIFIER`、`EAS_PROJECT_ID`、確認済みのリリース用フラグを登録します。DBパスワードやFirebase管理秘密鍵は登録しません。

### 作成済みのEASへ公開接続設定を登録する

2026年11月2日、所有者のWindows画面で`@oneight/tamaya-members-demo`の作成・連携と、`project:info`の成功を確認しました。実際のUUIDは`b84c88d0-b923-4a2a-b144-9fe5f0528f8d`です。リポジトリーの`app.json`と設定例もこの値へそろえています。

その後、所有者の画面で「Uploaded env file to production.」と登録後の9項目の一覧を確認しました。公開の7項目は設定ファイルと一致し、EASのUUIDと運用確認フラグはSensitiveとして伏せられています。11月3日のApple側のBundle ID登録に続き、11月4日にはEASへ同じ値を追加でき、10項目の一覧のうち表示された8項目が設定と一致することを確認しました。伏せ字の2項目の実値を再確認したとは扱いません。その後に公開文書の明示承認とリポジトリーへの正式反映が完了しました。次はPCで解決される設定と、PC・EASの承認フラグ更新、証明書・署名付きビルドを準備します。以下は公開接続設定の登録に使用した手順で、登録済みの接続設定やBundle IDを理由なく登録し直す必要はありません。

現在のアプリ直下の黒い画面で、公開接続設定だけをまとめたファイルを取得します。

```bat
curl.exe -fL --retry 3 "https://raw.githubusercontent.com/iichi86/tamayaapp/b8264bdd6b6ebc09e34947431ba7e942da035e33/deployment/eas-production.env" -o .env.eas.production
```

取得できたら、EASのproduction環境へ登録します。

```bat
npx eas-cli@25.3.0 env:push production --path .env.eas.production
```

登録結果を確認します。

```bat
npx eas-cli@25.3.0 env:list production
```

上記の固定コミットのファイルは、11月2日に使ったFirebaseの公開設定、APIのURL、店舗ID、EASのUUID、運用確認待ちのフラグの9項目です。当時はBundle IDが未確定だったため含めていません。`env:push`では`EXPO_PUBLIC_*`はPublic、それ以外はSensitiveとして登録され、一部の値は一覧で伏せられます。通常の`.env`全体をアップロードする操作ではなく、ファイルにない変数は削除しません。

現在のリポジトリーの`deployment/eas-production.env`は、登録済みBundle IDを加えた10項目で、公開文書の承認に基づき`RELEASE_BUSINESS_APPROVED=1`へ更新しています。今回の所有者は[Bundle IDの追加操作](#登録済みbundle-idをpcとeasへ反映する)も完了済みのため、Bundle IDや他の接続設定の再登録は不要です。次に変更するのはPCとEASの承認フラグで、これらの実環境への反映はまだ確認していません。EASの値は以前の一覧で伏せられており、承認後の値を読み取れたとは扱いません。

## 8．公開用ビルドの設定を確認する

アプリのフォルダーの`eas.json`を確認します。このリポジトリには、次の公開用設定を用意しています。

```json
{
  "cli": {
    "version": ">= 25.3.0",
    "appVersionSource": "remote"
  },
  "build": {
    "production": {
      "distribution": "store",
      "autoIncrement": true
    }
  },
  "submit": {
    "production": {}
  }
}
```

`production`が、TestFlightとApp Storeへ提出するための設定です。`autoIncrement`は提出ごとの内部ビルド番号を増やすためのものです。`app.json`の`version`は、お客様に表示されるバージョンです。

ファイルがない場合は最新版のソースに入っているか確認します。`eas.json.txt`という名前では使えません。エクスプローラーでファイル名拡張子を表示すると確認できます。

## 9．署名付きのiPhoneアプリをクラウドで作る

ここまでの準備が終わってから、次を実行します。

```bat
npx eas-cli@25.3.0 build --platform ios --profile production
```

初回は、Appleアカウントへのログインや署名の準備を求められます。

- Apple Developer Programに登録済みのApple Accountで進めます。
- 2ファクタ認証のコードを求められたら、手元のApple端末などで確認して入力します。
- チームを選ぶ画面では、今回アプリを公開する名義のチームを選びます。
- Bundle IDが`EXPO_IOS_BUNDLE_IDENTIFIER`の正式値と同じであることを確認します。
- 配布証明書やProvisioning Profileの生成を求められ、今回の初回作成であれば、EASに作成・管理させる方法を選べます。既存の証明書がある場合は、その内容を確認して進めます。

パスワードや認証コードを第三者へ送らず、自分で公式の作業画面へ入力してください。不明な契約・金額・名義が表示された場合は、確定する前に内容を確認します。

アップロードとビルドが始まると、Expoのビルド状況を開くURLが表示されます。待ち時間には幅があり、終了時刻は保証できません。**成功状態になるまで待ちます。** 失敗した場合は、そのビルドのログを確認して修正します。

ここで作る`.ipa`は、まだお客様がApp Storeから入れられる状態ではありません。WindowsからiPhoneへファイルをコピーするだけでインストールする手順でもありません。

## 10．App Store Connectへアップロードし、TestFlightで確認する

11月4日、今回のバージョン`1.0.0`・ビルド`2`のアップロード成功を所有者の画面で確認しました。現在はApple側の処理待ちです。[対象のTestFlight画面](https://appstoreconnect.apple.com/apps/6830628549/testflight/ios)で処理を確認し、完了後に「まず自分のiPhoneで試す」へ進みます。下記の提出コマンドは参照用です。成功済みの提出を繰り返す必要はありません。

段階1の成功したビルドを提出します。今回の設定では、必要なApp Store Connectのアプリ枠と内部テストの準備もEASが進めます。対象が今回の最新iOSビルドであることを確認して、次を実行します。

```bat
npx eas-cli@25.3.0 submit --platform ios --profile production --latest --auto-testflight-setup
```

この指定では最新のiOSビルドを選ぶため、通常は一覧からの手選択を省けます。別のビルドも存在する場合は、対象のIDを確認してから提出します。Appleのアプリや認証方法の確認が出たら、今回の名義・Bundle IDに合うものを選びます。アプリ枠の作成後、掲載名が「むさしの玉屋」であることも確認します。

EAS CLI 25.3.0では、通常、App Store Connect API Keyを使って提出します。これはApple側へのアップロード用の鍵です。使える既存の鍵があれば、その内容を確認して再利用できます。初回に`Generate a new App Store Connect API Key?`と聞かれた場合は、今回のチームで作成する権限があることを確認して作成します。続く役割の選択では、今回のアプリ管理用なら**`APP_MANAGER`**を矢印キーで選んでEnterを押します。すべての質問へ一律に`y`と入力する手順ではありません。

Appleの通常のパスワードを、API Keyやアプリ用パスワードの欄へ流用しないでください。この方法では、先にアプリ用パスワードを作って環境変数に設定する必要はありません。鍵やパスワードを、このチャットや公開GitHubへ載せる必要もありません。

提出後は、Apple側の処理が終わるまで待ちます。App Store Connectで対象アプリを開き、「TestFlight」のiOSビルド一覧に表示されることを確認してください。輸出コンプライアンスなどの質問が出たら、実際にアプリが使う暗号化の方式に基づいて回答します。本番で追加したSDKも含めて判断し、理由なく同じ回答を選ばないでください。

### まず自分のiPhoneで試す

1. iPhoneのApp Storeで「TestFlight」をインストールします。
2. App Store Connectの対象アプリで「TestFlight」を開きます。
3. 「内部テスト／Internal Testing」でグループを作り、ビルドと、テストするApp Store Connectユーザーを追加します。EASの処理などでグループがすでに作られている場合は、そのグループも使えます。登録者自身がテストする場合は、そのユーザーを選びます。
4. 招待メールをiPhoneで開き、TestFlightからアプリをインストールします。
5. 玉屋のアイコンを押して起動し、登録・スタンプ・クーポン・復旧・退会などの本番機能を確認します。

内部テストの対象はApp Store Connectのチームユーザーです。家族だから自動的に対象になるわけではありません。一般のお客様や、管理権限を持たせない家族に配る場合は、外部テストを使います。

外部テストではグループへビルドを追加し、説明・連絡先・テスト内容を入力して、必要なBeta App Reviewへ提出します。承認後に招待します。**TestFlightのビルドには90日の期限**があります。

TestFlightからインストールした公開用ビルドは、PCの`npm start`やExpo Goなしで起動できます。なお、会員情報などの通信には、本番サーバーとネットワーク接続が必要です。Expo Goの端末内デモデータが、そのまま本番会員として引き継がれるわけではありません。

## 11．App Storeの掲載情報を入力する

TestFlightで問題を直したあと、App Store Connectのアプリ管理画面で公開するバージョンを準備します。画面の案内に従い、次を入力・選択します。

- 日本語のアプリ名、サブタイトル、説明文、キーワード。
- カテゴリ、年齢区分の質問、権利・著作権などの情報。
- サポートURL、プライバシーポリシーURL。
- アプリが収集する情報と利用目的についてのプライバシー申告。本番の会員情報・利用履歴・追加SDKの扱いに合わせます。
- 配信する国・地域と価格。今回お客様のアプリ利用料は無料なので、無料で配布する設定を選びます。
- 画面から求められる、対応サイズのiPhoneスクリーンショット。

スクリーンショットは、**TestFlightで入れた本番版の実際の画面**を使います。Expo Goの起動用QRや、架空の機能を掲載しません。必要なサイズはApp Store Connectの現在の指定を確認し、対応する実機などで取得します。このリポジトリにあるブラウザー版の画像だけで、iPhoneの掲載画像がそろったと扱わないでください。

ログインが必要な場合は、審査担当者が利用できるテスト用アカウントとパスワードを審査情報欄へ入力します。スタッフ画面も確認が必要なら、テスト用スタッフと操作方法を用意します。実在するお客様の情報を使わせる必要はありません。

審査メモには、会員登録、会員証の表示、店舗でのスタンプ付与、クーポン利用の確認方法を具体的に書きます。サーバーは審査中も利用できる状態を保ちます。

## 12．審査へ提出し、承認後に公開する

1. 公開するバージョンに、TestFlightで確認した最終ビルドを指定します。
2. 未入力の必須項目や警告を確認し、直します。
3. リリース方法で、**承認後に自分で公開する手動リリース**を選びます。これで、審査承認直後に意図せず公開されるのを避けられます。
4. 内容を確認して、App Reviewへ提出します。
5. Appleからの結果・質問を確認します。修正を求められた場合は理由を読み、対応して再提出します。掲載情報だけの修正か、新しいビルドが必要かは指摘内容によって変わります。
6. 承認後、店の受け入れ準備とサーバーの状態を確認し、管理画面から公開を実行します。
7. 公開が反映されたら、お客様と同じようにApp Storeからインストールし、店舗の別端末との操作をもう一度確認します。

審査の日数や承認は保証できません。EASへのアップロード成功、Apple側の処理成功、審査承認、App Storeでの一般公開は、それぞれ別の段階です。

## 13．公開後の更新方法

不具合や機能を修正した場合は、ソースを保存し、自動テストと実機確認を行います。`app.json`の表示バージョンを更新し、同じproductionビルド・提出の手順を使います。内部ビルド番号は`autoIncrement`で管理します。

会員情報のバックアップ、障害時の対応窓口、スタッフの追加・退職、サーバー費用、Apple登録の更新も運用に含めます。店舗が支払う月額4,000円という将来のサービス料金と、Apple・Expo・サーバーの費用は別に整理してください。

## 公式の参考資料

更新日：2026年10月26日（日本時間）。サービスの画面・料金・審査要件は変わるため、契約・提出時には公式画面を確認してください。

- [Apple Developer Programの登録](https://developer.apple.com/programs/enroll/)
- [App Store Connect](https://appstoreconnect.apple.com/)
- [Appleの審査ガイドライン](https://developer.apple.com/app-store/review/guidelines/)
- [Expo EAS Buildの準備](https://docs.expo.dev/build/setup/)
- [ExpoのiOS提出手順](https://docs.expo.dev/submit/ios/)
- [ExpoのTestFlight手順](https://docs.expo.dev/submit/testflight/)
- [Expoのアイコン設定](https://docs.expo.dev/develop/user-interface/splash-screen-and-app-icon/)
- [Expoのバージョン管理](https://docs.expo.dev/build-reference/app-versions/)
- [Expoの料金](https://expo.dev/pricing)
