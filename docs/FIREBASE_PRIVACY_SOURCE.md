# Firebase Authenticationの公開資料の確認記録

確認日：2026年11月3日（日本時間）。公開用のプライバシー文面を準備するため、所有者が公式URLから取得して添付したHTMLを読み取りました。HTML内のスクリプトは実行していません。

## 出典と取得資料

- 資料名：Google / Firebase「Privacy and Security in Firebase」
- URL：https://firebase.google.com/support/privacy （添付HTMLのcanonicalも同じURL）
- 本文の改訂表記：`Last modified: September 24, 2026`
- ページ末尾の更新表記：`Last updated 2026-10-29 UTC.`
- 添付名：`firebase-privacy.html`、188,392バイト
- SHA-256：`657a0b2a4f27a25be103710ec613564d8e064cc82afaa329370ba64eab6fd4ca`

所有者のWindows画面で公式URLへの`curl.exe -fL`が完了し、その後添付された資料です。開発環境から同URLを独立して再取得したという記録ではありません。原本HTMLはリポジトリーへ収録せず、以下に必要な短い原文と日本語での解釈を記録します。

## 認証情報と保存期間

見出し：[Examples of end-user data processed by Firebase](https://firebase.google.com/support/privacy#examples-end-user-data-processed-by-firebase) のFirebase Authentication行。

一般のデータ例として `Passwords`、`Email addresses`、`Phone numbers`、`User agents`、`IP addresses` を列挙しています。目的は利用者の認証とアカウント管理で、ユーザーエージェント文字列とIPアドレスは登録・認証時の安全性確保と不正防止にも使うとの説明です。

> Firebase Authentication keeps logged IP addresses for a few weeks.

IPログの保存期間は「数週間」です。この資料に具体的な日数は示されていません。

> It retains other authentication information until the Firebase customer initiates deletion of the associated user, after which data is removed from live and backup systems within 180 days.

その他の認証情報はFirebaseの顧客が対象ユーザーの削除を開始するまで保持し、その後180日以内に稼働中のシステムとバックアップから削除するとの説明です。

## 処理地域

見出し：[Data storage and processing locations](https://firebase.google.com/support/privacy#data_storage_and_processing_locations) → `US-only services`。

> The Firebase Authentication service is run only from US data centers. As a result, Firebase Authentication processes data exclusively in the United States.

Firebase Authenticationについて、米国のデータセンターのみで稼働し、米国内のみで処理すると明記しています。他のFirebase製品の地域へ、この説明を一括して適用しません。

## 本アプリへ反映するときの範囲

- 本アプリはメール・パスワード認証を使用します。上記の一般表に電話番号があることだけを根拠に、利用者の電話番号を収集するとは記載しません。
- この資料はパスワードの保存形式を示していません。平文保存や特定のハッシュ方式を推測して記載しません。
- Firebase側の180日と、アプリの退会完了・ログイン停止、Supabaseの会員情報削除、会員への参照を外した業務記録の90日削除は別の処理です。Firebaseでのユーザー削除が通信障害等で未実行なら、アプリ内の申請日をFirebase側の削除開始日と断定しません。
- 数週間・180日は、この節で説明するFirebase Authenticationの対象情報についての説明です。Supabase・Renderや独自バックアップの全情報へ適用しません。
- Appleのプライバシー申告上の分類や利用者との関連付け、実アカウントの契約条件全体は、この資料だけでは確定しません。

反映先は[公開文書の確認案](LEGAL_REVIEW.md)、[App Store掲載・申告の準備案](STORE_LISTING.md)、`server/config/tamaya.json`の確認用プライバシー文面（`2026-11-03-draft-3`）です。正式な公開承認は別途確認します。

原文抜粋の出典：Google / Firebase、上記公式ページ。ページ末尾のライセンス表示は[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/)。日本語の説明は本プロジェクトで付記しています。
