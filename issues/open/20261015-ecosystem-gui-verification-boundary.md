# vlmkit：gpui.mbt ecosystemの実画面・操作検証を担う

Status: open — 設計課題。既存observerの能力・検証済み範囲は各profileの証拠を正とする。
Priority: P1
Decision date: 2026-10-15
Parent: [ecosystem方針・共通マージ基準](https://github.com/gpui-mbt/gpui.mbt/pull/82)
Related: [gpui-conformanceの責務](https://github.com/gpui-mbt/gpui-conformance/pull/14)

## 1. 役割

「GUI機能の動作確認」を、**指定したアプリ／ウィンドウについて、実画面と操作の観測証拠を採取・検査すること**として定義する。表示、レイアウト崩れ、フォーカス移動、操作結果、取得可能なaccessibility情報をブラックボックスで確認する。MoonBit専用にせず、アプリの製品runtimeへ組み込まない。

## 2. 現状と境界

[README](../../README.md)にはWebの決定的検証、visual regression、[macOS observer](../../native/macos/README.md)、[Linux X11 observer](../../native/linux/README.md)がある。Linuxを正式な開発対象としつつ、native inputとWaylandは別のgateで管理されている。[Linux admission課題](20261005-linux-native-observer.md)を再実装せず、その能力・検証の区別を引き継ぐ。

1. gpui-conformanceは共有fixtureとgpui.rs比較の最終判定を所有する。vlmkitは画像・window identity・操作・観測を返す。比較器を二重実装しない。
2. Yami-kumoは共通UXの期待値を所有する。vlmkitはそのfixtureを実行して結果を返し、見た目だけから操作仕様を決めない。
3. MZed／dshはアプリ固有scenarioとテストデータを所有する。テストは専用fixtureを使い、ユーザーの通常window・会話履歴・認証情報を対象にしない。
4. retained PNGの比較、native process内部の状態、外部observer、実入力は別の証拠層。スクリーンショット取得成功をクリック・IME・accessibility成功へ昇格させない。
5. 決定的なgeometry・state・event・pixel検査を主判定にし、VLMの診断は補助にする。通常の回帰検証を有料API key必須にしない。

## 3. 実装単位

1. **profileと能力表**：browser、macOS Apple Silicon、Linux X11、Linux Wayland、Windowsを混同しない。各profileでcapture・observation・input・AX等のimplemented/verified/unsupportedを記録する。未提供profileは未対応と明示する。
2. **対象束縛と安全性**：session/run ID、PID／process起動identity、window ID、capture geometry、scaleを関連付ける。観測時と入力直前にidentityを再検証する。対象が曖昧・消失・置換されたら入力を拒否し、別windowへのfallbackをしない。
3. **GUI scenario adapter**：fixture ID、許可操作、期待する状態変化、deadline、artifact出力先を受ける薄いadapterを追加する。既存profileの能力を超える操作は事前に拒否し、理由と未検証状態を返す。
4. **証拠export**：実行したコマンド・候補SHA・tool version・OS/arch・観測層・時刻・window identity・操作log・画像／AXの取得条件・hashを保存する。gpui-conformanceやYami-kumoのfixture IDへ関連付ける。既存schemaを変更する場合はversionを付ける。

## 4. 入力とユーザー画面を守る条件

1. 背面・被覆・focus喪失時に安全に対象限定できないprofileでは入力しない。強制activateや座標だけのクリックで埋め合わせない。対象に限定できる操作でも、profileの明示した条件と許可範囲を守る。
2. 同じタイトルの別window、PID再利用、window ID変更、close直後、capture後の移動・scale変更を反例に含める。
3. observerで取得できない状態をアプリ内部の自己申告だけで「外部から確認済み」にしない。telemetryは別証拠として保持する。
4. timeout時のcleanupは自分が起動したfixture/processだけに限定する。ユーザーアプリのkill・最前面切替・他windowへの入力をしない。
5. hidden/offscreenのretained image診断は有用だが、visible window・物理入力のqualificationとは分ける。

## 5. 受入条件

| scenario | 期待する結果 |
| --- | --- |
| 許可したfixtureで表示・操作する | 同じrunとwindowに結び付いたbefore/action/afterの証拠を返す |
| 別windowが前面に来る／対象が消える | 誤配信せず拒否し、場所・観測事実・対処を報告する |
| 同じタイトルのwindowが複数ある | 一意に束縛できなければ入力しない |
| 画像のみ取得する | visualの結果だけを返し、input/IME/AXは未実行のままにする |
| Wayland等で必要能力がない | unsupported/unverified相当を明示し、X11の成功を流用しない |
| 故意のUI崩れ／無効化された操作 | 決定的検査で検出する。VLMの文面だけでPASSにしない |
| timeout／artifact欠損 | 完了・成功にせず、自分のfixtureだけをcleanupする |

上表は今後の受入テストであり、この文書追加で実行済みではない。既存のnative安全性課題を先に完了し、能力が未確認のprofileへ入力テストを広げない。

## 6. 開発・検証

[AGENTS.md](../../AGENTS.md)と[project conventions](../../.claude/CLAUDE.md)を維持する。source変更後は`pnpm build`を行い、依存toolchainを準備してテストする。keyなしの経路は`env -u OPENROUTER_API_KEY pnpm test`で検証し、実行したコマンドとPASS/FAIL/未実行を分ける。nativeは各observer READMEのprofile固有手順を使う。今回のMarkdown追加ではbuild・test・native操作は未実行。

## 7. マージ基準・完了条件

共通`ecosystem-merge-v1`に従い、**最新HEADの必要CIがすべてcompleted/success AND 同じHEADを実際にレビューした`gpt-6.1-sol/xhigh`のApprove相当**を必要とする。モデル・effort・SHA・指摘と処置・判定・証拠URLをGitHubへ記録する。P0/P1、必要checkのskip、未実行、古い承認は残さず、HEAD更新後は再検証・再レビューする。既存保護を迂回しない。

1. [ ] GUI検証とGPUI互換判定の所有者が分離されている。
2. [ ] 対象window束縛の正常系と誤配信防止の反例を自動検証できる。
3. [ ] profileごとの未対応／未検証を維持した証拠を他repoへ渡せる。
4. [ ] gpui-conformanceまたはYami-kumoの実fixtureで往復を1件確認する。
