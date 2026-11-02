# Supabaseのバックアップと隔離した復元確認

更新日：2026年11月2日。現在のPostgreSQL版が対象です。以前のSQLite用の`server/data`コピーとは手順が異なります。

この文書で実施済みなのは、架空データを使ったローカルPostgreSQLのバックアップ・復元確認です。所有者のSupabaseからの取得、実Firebaseとの照合、本番への復元、定期実行はまだ行っていません。

## 保存するもの

| 対象 | このDBバックアップに入るか | 別途管理すること |
| --- | --- | --- |
| 非公開の`tamaya`スキーマ10テーブル | 入る | 会員、権限、残高、履歴、特典、お知らせ、監査、再送記録、退会処理の状態を含む |
| Firebase Authenticationの認証アカウント・パスワード | 入らない | 復元時にも現在のFirebaseを本人情報の照合先とする |
| DBログインロール・パスワード | 入らない | 実行用ロールは別途作成・再設定。管理者パスワードをアーカイブへ書かない |
| Firebase Admin JSON、QR署名キー、Renderの秘密設定 | 入らない | 所有者の保護された設定・保管先で別途管理 |
| Supabaseの他スキーマ、プロジェクトの全機能 | 入らない | このアプリ用スキーマの取得であり、Supabaseプロジェクト全体の複製ではない |

`pg_dump`のcustom形式は暗号化ではありません。会員の情報を含むため、アクセス権と暗号化が確認済みの専用保存先を用意します。公開GitHub、チャット、共有フォルダー、意図しないクラウド同期先へ置きません。Dockerで復元する場合は、Dockerの保存領域も保護対象です。

Supabaseの[公式バックアップ資料の公開ソース](https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/platform/backups.mdx)では、自動日次バックアップはPro・Team・Enterpriseが対象です。Freeについては定期的なdumpと別の場所での保管を推奨しています。今回のFree環境で自動日次バックアップが取れているとは確認していません。

## 自動バックアップを選ぶ場合の効果と費用

| 方法 | 役に立つ場面・負担 | 確認できている費用・保存範囲 |
| --- | --- | --- |
| Freeのまま手動取得 | 誤削除・破損時に取得時点へ戻す。担当者が取得・保管・復元を管理する | 追加のサービス契約料なし。保存媒体や作業は別途必要 |
| Supabase Proの日次取得 | 毎日コピーを作る作業をサービス側へ任せ、過去の保存時点から復旧する | 基本月額25米ドル。Proは直近7日分の日次バックアップ。追加利用・税・為替は別途確認 |

2026年11月2日に[公式Compute資料の公開ソース](https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/platform/manage-your-usage/compute.mdx)と[公式Billing FAQ](https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/platform/billing-faq.mdx)を確認しました。小規模な1プロジェクトでは、基本25ドルに含まれる月10ドル分のCompute CreditsがMicro/Nanoの約10ドルを相殺する計算です。複数プロジェクト、増強、容量・転送量等の超過では加算されます。現在の契約画面の金額・税・更新条件を所有者が確認して選びます。契約・プラン変更は実行していません。

日次バックアップは、毎回正常に取得できている場合でも、最後の取得から後の最大約1日分を含まない可能性があります。自動取得を選んでも、現在のFirebaseや退会・権限停止・使用済み特典との照合、復元練習、障害時の担当は必要です。

## 役割と保管日数の案

- 所有者は、取得担当者・保護された保存先・保管日数を決めます。
- 開発担当は、最初の取得と隔離した復元を確認し、日時・成否・復元できた時点を記録します。
- 当面の案は「営業日の閉店後に取得し、正常に取得できた直近7日分を保管」です。まだ採用・自動化された運用ではありません。休業日、PCが動かない日、担当者不在時も含めて決めます。
- 新しいバックアップが作れなかった日に、最後の正常なコピーを削除しません。保存期限を過ぎた不要なコピーは、決めた担当者が保存先から削除します。

復元できるのはバックアップの取得時点までです。それ以降の付与・特典利用・退会・権限停止を戻すには、別途の照合が必要です。「毎日取得できる」「損失は必ず24時間以内」といった保証は、未確認の現段階では行いません。

## 本番バックアップ取得の準備

所有者のWindows PCにPostgreSQLのクライアントツールがあるか、担当者が確認します。`pg_dump`はサーバーと同じメジャー版を基本にし、今回は17系で検証しました。Node.jsやExpoの導入だけでは`pg_dump`は入りません。DockerやPostgreSQL一式を、この文書のためだけに今すぐ所有者がインストールする必要はありません。

実際のSupabaseのバージョンは、管理画面のSQL Editorで次を実行して確認します。17系でない場合は、担当者が取得・復元に使うクライアントと復元先の版を合わせます。

```sql
SHOW server_version;
```

以下は`pg_dump`が実行できるコマンドプロンプト用です。保存先のアクセス制限・ドライブ暗号化、CA証明書、取得担当者の権限を確認してから実行します。APIの通常利用を続けながら取得できますが、同時にDBスキーマの変更は行いません。

バックアップには初期準備用のDB所有者接続を使います。日常のAPI用`tamaya_runtime`のパスワードではありません。Session poolerの5432番を使い、Transaction poolerへ切り替えません。接続先は現在の所有者のプロジェクト設定を使います。

まず、アプリ直下へ移動します。

```bat
cd /d "%USERPROFILE%\Downloads\tamaya-server-setup\tamayaapp-main"
```

既存の公式CAを使い、TLSの証明書確認を有効にします。`server\supabase-ca.crt`が実際に保存されていることを先に確認します。

```bat
set "PGSSLMODE=verify-full"
set "PGSSLROOTCERT=%CD%\server\supabase-ca.crt"
```

担当者が準備した保護済みの保存先を使います。以下は`C:\tamaya-private\backups`を使う場合の例です。

```bat
if not exist "C:\tamaya-private\backups" mkdir "C:\tamaya-private\backups"
```

フォルダーを作成しただけでは保護設定は完了しません。担当者がアクセス権と保存ドライブの暗号化を確認した後、ファイル名を準備します。

```bat
for /f %T in ('powershell -NoProfile -Command Get-Date -Format yyyyMMdd-HHmmss') do set "TAMAYA_BACKUP_TAG=%T"
set "TAMAYA_BACKUP_FILE=C:\tamaya-private\backups\tamaya-%TAMAYA_BACKUP_TAG%.dump"
```

これはコマンドプロンプトへ入力する形式です。`.bat`化するときは`for`変数等の書式を担当者が調整します。日時を付けた新しいファイル名で取得し、既存の正常なファイルへ上書きしません。

```bat
pg_dump --host=aws-0-ap-northeast-2.pooler.supabase.com --port=5432 --username=postgres.ohpbgirqcfxinhntmavk --dbname=postgres --password --schema=tamaya --format=custom --no-owner --no-acl --enable-row-security --file="%TAMAYA_BACKUP_FILE%.partial"
```

DBパスワードは`pg_dump`の非表示プロンプトへ入力します。URLやコマンド本文、`PGPASSWORD`へ実際のパスワードを入れる手順にはしていません。

`tamaya`の各テーブルはFORCE RLSです。管理者であってもRLSを回避しない接続では、通常のdumpが失敗することがあります。`--enable-row-security`を付け、`tamaya_api`の全行ポリシーを使えるDB所有者で取得します。将来ポリシーを変更した場合は、一部の行だけを取得していないか、担当者が改めて確認します。

取得コマンドが終わった直後、終了コードを確認します。

```bat
echo %ERRORLEVEL%
```

結果が`0`で、エラーがない場合だけ、正式なファイル名へ移します。失敗した`.partial`は正常なバックアップとして扱いません。

```bat
move /-Y "%TAMAYA_BACKUP_FILE%.partial" "%TAMAYA_BACKUP_FILE%"
pg_restore --list "%TAMAYA_BACKUP_FILE%"
```

`--list`はアーカイブの目録を読めることの確認です。復元成功の代わりにはなりません。ファイルの日時・サイズ、取得結果、使用したツール版を記録し、最初の一式を次の隔離環境へ復元して確認します。証明書・通信・権限のエラーではTLS確認を無効化せず、接続設定を確認します。

## 開発担当による隔離した復元

この段階で本番の接続先を`pg_restore`へ渡しません。以下の例は、外部へポートを公開しない使い捨てのローカルDockerです。所有者のPCにDockerを必須とするものではありません。保存先の保護を確認した開発環境で行います。

既に同じ名前のコンテナがあれば、他の作業に使っていないことを確認し、別の新しい名前を使います。復元するデータ・インデックスと作業環境の空きメモリを確認し、十分な容量を用意します。次は上限1GBの一時領域を使う新規の空環境の例です。

```bat
docker run --detach --rm --name tamaya-restore-check --tmpfs /var/lib/postgresql/data:rw,nosuid,size=1g -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine
docker exec tamaya-restore-check pg_isready --username=postgres
```

`accepting connections`を確認してから続けます。ここでのtrustは外部ポートを公開しない隔離コンテナ専用です。本番の認証設定には使いません。

```bat
docker exec tamaya-restore-check createdb --username=postgres tamaya_restore_check
docker exec tamaya-restore-check psql --username=postgres --dbname=tamaya_restore_check --set=ON_ERROR_STOP=1 --command="CREATE ROLE tamaya_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;"
docker cp "%TAMAYA_BACKUP_FILE%" tamaya-restore-check:/tmp/tamaya.dump
docker exec tamaya-restore-check pg_restore --username=postgres --dbname=tamaya_restore_check --format=custom --no-owner --no-acl --exit-on-error --single-transaction /tmp/tamaya.dump
```

先に作るのはポリシーが参照する`tamaya_api`ロールだけです。空の復元先へ完全なアーカイブを戻す前に、既存テーブルを作ったり、本番DBを指定したりしません。途中のエラーを無視して続ける復元にはしません。

`--no-acl`で権限を移植しないため、復元先の所有者で現在のマイグレーションを再適用し、非公開スキーマ・RLS・実行用ロールの権限をそろえます。現在のSQLは既存の会員データを消さない構成です。

```bat
docker cp server\supabase\001_initial.sql tamaya-restore-check:/tmp/001_initial.sql
docker exec tamaya-restore-check psql --username=postgres --dbname=tamaya_restore_check --set=ON_ERROR_STOP=1 --file=/tmp/001_initial.sql
```

少なくとも、10テーブルの件数、会員番号と残高、付与日時と金額、特典の期限・使用状態、お知らせ、スタッフの停止状態、同意した版、監査、再送記録、退会処理の状態を確認します。`pg_class.relrowsecurity`と`relforcerowsecurity`が10テーブルすべて有効であることも確認します。

稼働中の現行DBには取得後の操作が加わります。異なる時点の件数が一致することを合格条件にはせず、取得日時と確認対象の記録を対応させて評価します。

実行用ログインはアーカイブに含まれません。別途作成して`tamaya_api`のみを付与し、管理権限・RLS回避権限がない接続で読み書きの確認を行います。管理者用接続を常設APIへ登録する方法で代替しません。

確認後は、この手順で作成したコンテナを削除します。実際の復元資料・作業ファイルは保管方針に従って削除します。

```bat
docker rm --force tamaya-restore-check
```

## 本番へ戻す前の照合

バックアップを戻しただけで本番へ切り替えません。以下の照合・切り替えは、取得した本番バックアップではまだ検証していません。

1. **現在のFirebaseとの照合**：バックアップにある会員・スタッフのUIDを、同じFirebaseプロジェクトの現在の認証アカウントと照合します。既に削除された認証アカウントの会員情報を、復元後に再利用しません。メールアドレスが同じという理由だけで、新しいUIDへ残高を移しません。
2. **退会と削除**：バックアップ後に退会した人の情報が復元先へ戻る場合があります。完了済みの退会ジョブはUIDが消去されるため、そのテーブルだけでは全件を照合できません。現在のFirebase、現在利用できる退会記録、問い合わせ対応記録と照合し、必要な削除を隔離環境で完了します。この照合ツールの自動化は未実装です。
3. **スタッフ権限**：バックアップ後に停止した権限が、古い状態へ戻る場合があります。現在の承認済みのオーナーを確認し、他の権限は現在の承認に基づいて再設定します。古い権限一覧をそのまま有効にしません。
4. **付与・使用済み特典**：取得後のスタンプ付与や特典利用はdumpに入りません。レジ・担当者の記録等で照合します。照合が終わるまでスタンプ・特典の操作を停止し、使用済み特典が復元によって再利用できる状態を避けます。自動で正しい最新状態へ復旧したとは扱いません。
5. **接続と秘密設定**：FirebaseプロジェクトIDと店舗ID、最新の公開条件、証明書、新しい実行用DB接続、QR署名キー等を確認します。DBロールのパスワード・Admin JSON・署名キーはdumpとは別に復旧します。漏洩や保管状態が不明な秘密値は更新します。
6. **切り替え**：APIと退会ワーカーへの新しい操作を止めた状態で、担当者が最終照合・切り替えを行います。切り替え後に`/health`、本人確認、スタッフ権限、付与・特典の整合性を確認して再開します。障害時は旧接続と新接続へ同時に書き込ませません。

通常のAPIを復元先へ向ける前に行う作業です。復元先に現在のFirebase Admin JSONを設定してAPIを起動すると、退会ワーカーが保留中の削除を実行し得るため、単なる復元検査の段階では起動しません。

## 今回確認した結果

2026年11月2日、架空データのPostgreSQL 17.11を2つの使い捨てコンテナで検証しました。外部サービスへ接続せず、ローカルの試験用CAを使ったTLSの`verify-full`接続で取得・復元しました。

- 取得元のDB所有者は`NOSUPERUSER`・`NOBYPASSRLS`。10テーブルすべてでRLSとFORCE RLSを有効化しました。
- 通常の`pg_dump`はRLSにより失敗し、`--enable-row-security`付きのcustom形式で成功しました。
- 新しい別のクラスタに参照先ロールを作成し、`pg_restore --no-owner --no-acl --exit-on-error --single-transaction`とマイグレーションの再適用が成功しました。
- 全10テーブルについて、全行の内容から算出したハッシュと件数が一致しました。会員2件、付与12件、特典2件、お知らせ1件、権限2件、監査3件、再送記録1件、退会ジョブ2件、店舗1件、マイグレーション2件です。
- 残高2、使用済みと未使用の特典、pendingとcompletedの退会状態が保持されました。
- 復元先もRLSとFORCE RLSが10テーブルすべて有効でした。実行用ログインは存在せず、別途限定ロールを作成した後に会員を参照できました。
- コンテナ・試験用アーカイブ・証明書を削除しました。本番データ、実際の認証ユーザー、所有者の秘密設定は使用していません。

これはローカルの取得・復元機能の検証結果です。実Supabaseでの取得、保護された保管先、日次取得・期限削除、監視、現在のFirebase・退会・権限・利用記録との照合、本番復旧は引き続き確認が必要です。
