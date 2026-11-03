# App Store掲載情報の同期準備

更新日：2026年11月4日。EAS CLI 25.3.0に同梱されたMetadataの設定スキーマ・コマンド・読込み処理を確認し、掲載文の手入力を減らすための公開設定を用意しました。App Store Connectへの同期や審査提出は、まだ実行していません。

## 用意した公開設定

[deployment/store.config.json](../deployment/store.config.json)は、[掲載準備案](STORE_LISTING.md)の日本語文面を設定ファイルにしたものです。

| 設定 | 内容 |
| --- | --- |
| スキーマ | `configVersion: 0` |
| 対象バージョン | `1.0.0` |
| 言語・掲載名 | 日本語／むさしの玉屋 |
| 文面 | サブタイトル、説明文、キーワード、プロモーション用テキスト |
| URL | 本番サーバーのサポートページ、プライバシーポリシー |

氏名・審査連絡先・審査用アカウント・パスワード・API Keyは含めていません。著作権者、年齢区分、カテゴリ、価格、配信先の設定もこのファイルで確定したものではありません。スクリーンショットが未提供のため、画像パスやブラウザー版の画像も入れていません。

`apple.review`は省略しています。EASのスキーマでは、これを設定する場合に`firstName`・`lastName`・`email`・`phone`が必須になります。実際の連絡先がない段階で、仮の氏名やメールアドレスを入れて検証を通す方法にはしていません。

## 実際に同期する段階のWindows手順

署名付きビルドとApp Store Connectのアプリが用意できた後に使う手順です。アプリの最新版を準備する手順とは別の段階です。EASへのログインと、必要なApple側の認証は所有者のPCで行います。

アプリ直下へ移動し、公開設定を取得します。

```bat
cd /d "%USERPROFILE%\Downloads\tamaya-server-setup\tamayaapp-main"
```

```bat
if not exist deployment mkdir deployment
```

```bat
curl.exe -fL --retry 3 "https://raw.githubusercontent.com/iichi86/tamayaapp/main/deployment/store.config.json" -o "deployment\store.config.json"
```

公開設定を基に、PC内だけで使う`.env.store.config.json`を初期化し、PCの`eas.json`にその保存先を設定します。既存の同名ファイルがある場合は保持します。このコマンドには個人情報やパスワードを入力しません。

```bat
node -e "const fs=require('node:fs'); const target='.env.store.config.json'; const eas=JSON.parse(fs.readFileSync('eas.json','utf8')); if(!eas.submit?.production?.ios) throw new Error('production ios submit profile is missing'); if(!fs.existsSync(target)) fs.copyFileSync('deployment/store.config.json',target,fs.constants.COPYFILE_EXCL); eas.submit.production.ios.metadataPath=target; fs.writeFileSync('eas.json',JSON.stringify(eas,null,2)+'\n'); console.log('Local metadata configuration is ready.');"
```

`.env.store.config.json`は既存の`.gitignore`と`.easignore`の`.env*`に該当し、GitHubへの登録とネイティブビルドのアーカイブから除外されます。実際の審査連絡先やアカウント情報は、必要な段階でこのPC内のファイルへ追加します。チャットへ送る必要はありません。

ZIPで用意したPCでは、同じ黒い画面で次を設定します。

```bat
set "EAS_NO_VCS=1"
set "EAS_PROJECT_ROOT=%CD%"
```

設定をローカルで検証します。

```bat
npx eas-cli@25.3.0 metadata:lint --profile production --json
```

検証結果が空の配列`[]`であることを確認します。CLI 25.3.0のこのコマンドは、検証の問題をJSONとして返すため、プロセスの終了だけで成功扱いにせず、結果も確認します。これは設定ファイルの検証であり、Appleでの名称の利用可能性、必須項目の完成、審査承認を示すものではありません。

実際の著作権者を確認してPC内の`apple.copyright`へ設定し、審査連絡先・審査用アカウント・画像等をそろえてから同期します。これは初回版`1.0.0`向けの設定です。将来の更新時は、その時点のバージョンと既存のストア設定を確認してから使います。

```bat
npx eas-cli@25.3.0 metadata:push --profile production
```

このコマンドはApp Store Connectの掲載情報を書き換えます。CLI 25.3.0では、版を指定した場合に未設定の著作権欄を`null`として渡す処理があるため、公開設定を初期化しただけの状態で同期しません。既存の実際の著作権表記がある場合はそれを保持します。EAS MetadataはCLI上でbetaと表示される機能なので、同期結果とApple側の表示を確認します。同期を実行しただけでApp Review提出や一般公開が完了するものではありません。

## 個人情報を含む項目はPC内で追加する

連絡先等を追加する段階で、実際のApp Store Connectの既存情報を確認します。既存の審査連絡先や審査用アカウントがある場合は、それを確認して再利用し、作り直す作業を増やしません。

| PC内の`apple.review`に追加するキー | 用途 |
| --- | --- |
| `firstName`・`lastName` | 審査連絡先の氏名 |
| `email`・`phone` | 審査担当者が連絡できるメール・国番号付き電話 |
| `demoUsername`・`demoPassword` | 実際に作成・メール確認済みの審査用アカウント |
| `demoRequired` | 全機能の確認にログインが必要かを示す値 |
| `notes` | 下記を基に、実際の審査用アカウント・確認範囲に合わせた操作案内 |

この公開設定の作成によって、審査用アカウントを新規作成したり、既存会員のパスワードを取得したりした状態にはなりません。パスワードは`notes`に混ぜず、専用の`demoPassword`項目で扱います。公開設定ファイルへこれらの情報を移さないでください。

## 審査メモの公開可能な下書き

以下は実装済みの機能・条件だけを記した下書きです。審査用アカウントの作成・権限確認が済んだ後、その実態に合わせてPC内の`notes`へ反映します。

> 本アプリは、東京都中野区の実店舗「むさしの玉屋」の無料会員サービスです。一般会員向けにホーム、会員証、特典、お店の情報を提供します。
>
> 会員登録はメールアドレスとパスワードで行い、登録メールの確認後にニックネームを登録します。同じアカウントで機種変更後も会員情報を利用できます。パスワード再設定は登録メールで行います。
>
> 来店スタンプは、生菓子・ギフト商品が対象の500円以上のお会計について、店舗スタッフが確認して付与します。同じ会員につき日本時間で1日1回です。5個のスタンプを消費すると、スタッフが当日の対象商品から選ぶ生菓子1つと交換できる特典を発行します。有効期間は発行から90日間で、追加購入は不要、他の割引・クーポンと併用できます。
>
> スタッフ用の機能は、オーナーが権限を付けたアカウントに表示されます。カメラはスタッフが会員QRコードを読み取るために使用します。QRの読取りだけではスタンプは付きません。写真・動画の保存や映像送信は行いません。
>
> 本アプリ内に商品の購入・課金機能はありません。会計と特典の受取りは実店舗で行います。
>
> アプリの「設定」から利用規約・プライバシーポリシー・サポート情報を確認でき、現在のパスワードによる本人確認と確認欄への「退会する」の入力により、退会・アカウント削除を申請できます。

## 別に確認する項目

- Appのプライバシー申告は、[掲載準備案](STORE_LISTING.md#appのプライバシー申告用の整理)と実際のSDK・Appleの定義を照合します。この公開設定で申告完了にはなりません。
- 年齢区分は、Apple側の現行質問と実装に合わせます。公開設定に未確認の回答を埋めていません。
- 実際の著作権者・価格・配信先・カテゴリ・リリース方法は、該当するApple側の設定と合わせます。
- スクリーンショットは、署名付きアプリの実際の画面を用意してから、Appleの指定する表示タイプへ追加します。仮の画像パスは用意していません。

## 検証の範囲

11月4日、この公開JSONをEAS CLI 25.3.0の同梱スキーマで検証し、問題がないことを確認しました。隔離した一時プロジェクトでも、同CLIの`metadata:lint --profile production --json`を実行して空の配列`[]`を確認しました。掲載文との一致と、タイトル6文字・サブタイトル13文字・プロモーション58文字・説明502文字・キーワード73バイトも照合しています。

上記のローカル初期化コマンドについても、架空の連絡先・審査用情報を入れた一時ファイルを使い、再実行時に既存の非公開設定と`.env`の内容、無関係なEAS設定を保持することを確認しました。既存の`.gitignore`で`.env.store.config.json`が除外されることも確認しました。これらは認証情報を使わないローカル処理で、App Store Connectへ接続・同期した結果ではありません。一時プロジェクトは削除しています。
