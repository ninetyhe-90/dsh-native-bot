# DSH Desk Pet

**DeepSeek Harness をデスクトップに。考えている、作業している、話している様子が見えます。**

DeepSeek Harness 用デスクトップペットプラグイン · 透明な最前面ウィンドウ · イベント駆動の 5 状態 · 2 種類のスキン · DSH と一緒に起動・終了

対応 **@deepseek-ai/dsh 0.2.1-rc.2** · Electron 45 · [中文](../README.md) · [English](README.en.md) · [한국어](README.ko.md)

![5 つの状態とクジラのスキン](images/states.png)

---

## これは何か

DSH Desk Pet は、自分のマシン上で動く DSH プラグインです。DSH が起動すると画面右下に小さなウィンドウを開き、セッションで起きていることをキャラクターの動きとして表示します。

- **進み具合が見える**：考え中、ツール呼び出し中、返答中でそれぞれ動きが変わり、ツール呼び出しではコマンドやファイルパスを吹き出しに表示します。
- **その場で聞ける**：左下のボタンで入力欄を開き、Enter で送信。ブラウザに戻る必要はありません。
- **会話は 1 つ**：ペットは常に `desk-pet` セッションを使います。Web UI でも同じ履歴が見え、再起動後も自動で復元されます。
- **エラーを黙らない**：モデルの失敗、ツールの拒否、ターンのブロックが起きると、キャラクターが震えて理由を表示します。

ペット自身はカーネルを持ちません。モデル設定、セッションの保存、権限ポリシーはすべて起動元の DSH プロセスのものを使い、DSH が終了するとペットも終了します。

## 設計方針

| 方針 | 意味 |
| --- | --- |
| DSH に結び付ける | DSH プラグインからのみ起動し、独自のカーネルやセッション保存は持たない。Electron を直接起動するとエラーで終了する |
| 状態には根拠がある | すべての動きが DSH のセッションイベントに対応する。ランダム再生やタイマーでの推測はしない |
| エラーははっきり出す | Electron が見つからない、セッション復元の失敗、スキン設定の誤りはすべてエラーにし、黙って既定値に切り替えない |
| 描画層に権限を持たせない | ページが使えるのは IPC メソッド 4 つだけ。`contextIsolation` と CSP を有効にし、Node にもネットワークにも触れない |

## インストール

プロジェクトのディレクトリで実行します。

```sh
npm install                       # 同梱の DSH と Electron を入れる。グローバルの dsh は不要
npm start                         # dsh web --patch cordis.patch.yml と同じ
```

ブラウザで `http://127.0.0.1:3080/` を開くと、同時に画面右下にペットが現れます。追加の引数はそのまま渡せます（例：`npm start -- --no-open`）。

### 普段のプロファイルに組み込む

普段の `dsh web` でもペットを起動したい場合は、`cordis.patch.yml` の `insert` ブロックを `$DSH_HOME/profiles/web/cordis.patch.yml` に追記し、プラグインのパスを手元の絶対パスに書き換えます。

### インストールが触らないもの

- `npm start` は `--patch` でプラグインを一時的に重ねるだけで、`$DSH_HOME` 配下のプロファイルファイルは**変更しません**。
- プラグインが購読するのは `desk-pet` セッションのイベントだけで、ほかのセッションの内容は**読みません**。
- ペットのプロセスは DSH の `ctx.subprocess` が管理し、DSH の終了時やプラグインのアンロード時に終了・回収されます。バックグラウンドに残りません。
- シェルで `NODE_ENV=production` が設定されていると npm は devDependencies を飛ばします。そのため Electron は `dependencies` に入れてあり、インストール後すぐ使えます。

## 操作

| 操作 | 動作 |
| --- | --- |
| キャラクターをドラッグ | ウィンドウを移動 |
| 左下のボタン | 入力欄を開く / 閉じる。Enter で送信、`Esc` で閉じる |
| 右クリック | メニュー：最前面の切り替え、DSH データディレクトリを開く、終了 |
| 右下のボタン | ペットを閉じる（DSH はそのまま動き続ける） |
| Web UI で `/pet` と入力 | 閉じたペットを再び開く。開いていれば最前面に出す |

## 状態はどこから来るか

| キャラクター | 動き（avatar スキン） | DSH イベント |
| --- | --- | --- |
| 待機 | ゆっくり首を揺らす | イベントなし |
| 思考 | 首をかしげ、頭上で点が跳ねる | `turn/start`、`step/start`、`agent/status=running` |
| 作業 | 素早くうなずき、歯車が回り、吹き出しにコマンド | `tool/call` |
| 発話 | 弾みながら、吹き出しに返答をタイプ表示 | `assistant/message` |
| エラー | 震えて灰色になり汗をかき、吹き出しに理由 | `tool/result` の `message.isError`、`turn/end` の `reason.kind` が `error` / `blocked` |

## 設定

`cordis.patch.yml` のプラグイン項目に `config` を追加します。

```yaml
- insert:
    - id: desk-pet
      name: /path/to/dsh-native-bot/plugin/desk-pet.mjs
      config:
        skin: whale
```

| 項目 | 既定値 | 役割 |
| --- | --- | --- |
| `skin` | `avatar` | `avatar`（ビットマップの頭像、全体で動く）か `whale`（手描き SVG、パーツごとに動く）。不正な値はエラー |
| `sessionId` | `desk-pet` | ペットが使うセッション id |
| `title` | `桌宠` | Web UI サイドバーでのセッション名。Web UI で手動で付けた名前があればそちらを優先 |
| `cwd` | DSH の作業ディレクトリ | 新しくセッションを作るときの作業ディレクトリ |
| `projectDir` | プラグインのあるリポジトリ | ペットのフロントエンドがあるディレクトリ |
| `electron` | プロジェクト依存の Electron | Electron 実行ファイルのパス |

ペットは DSH に接続するとセッションを開き、セッションの作業ディレクトリと同じワークスペースに入れます（なければ自動で登録）。Web UI のサイドバーから見つけて、そのままブラウザで会話を続けられます。

## 見た目を変える

- **`avatar`**：`src/renderer/avatar.png`。背景は透明、内容の境界でトリミング、幅 640px 前後。このファイルを差し替えるだけで、動きの変更は不要です。
- **`whale`**：`src/renderer/index.html` 内の `<svg>`。グラデーションと CSS キーフレームで動き、画像素材は使いません。
- ビットマップは全体でしか動かせません。まばたきや口の開閉には、同じキャラクターの目を閉じた差分と口を閉じた差分が必要です。
- 他人の作品を使うのは個人利用なら問題ありませんが、公開する前に使用権を確認してください。

## 互換性

| コンポーネント | 値 |
| --- | --- |
| DSH | `@deepseek-ai/dsh` 0.2.1-rc.2。プロジェクト依存としてインストール |
| Electron | 45.x。UI 専用で、DSH カーネルは動かさない |
| Node | ≥20.11。DSH の実行に使用 |
| OS | macOS で検証済み。Windows / Linux は未検証 |

## 困ったとき

```sh
npm test                                      # 構文チェック + ユニットテスト（DSH の起動は不要）
npm run test:e2e                              # 実 Electron の結合テスト：閉じる -> /pet -> 再表示。ペットが一瞬デスクトップに出る
DSH_PET_SELFTEST=1 npm start -- --no-open     # エンドツーエンドの自己テスト：専用セッション desk-pet-selftest で 1 文送って /tmp/pet-selftest.png を保存し終了
DSH_PET_SHOT=/tmp/pet.png DSH_PET_SHOT_STATE=talking ./node_modules/.bin/electron .
                                              # 描画だけ確認、DSH には接続しない。状態は thinking / working / talking / error
```

プラグインとペットの診断メッセージは `[desk-pet]` で始まり、DSH を起動したターミナルに出力されます。3080 が開けないときは、まず `dsh web` が実際に動いているか確認してください。`--patch` は `web` の直後に置く必要があります。

## 既知の制限

- 吹き出しのタイプ表示はローカルでの演出で、プラグインはまだトークン単位の `agent/assistant-stream` を受け取っていません。
- 承認が必要なツール呼び出しはペットでは承認ダイアログを出さず、DSH のポリシーに従います。Web UI で承認できます。
- ウィンドウはメインディスプレイに固定され、ディスプレイをまたいで追従しません。
- アニメーションは CSS キーフレームのみで、ボーンやフレームシーケンスはありません。

## 構成

```
plugin/desk-pet.mjs     DSH 側プラグイン：ペットの起動、イベント転送、prompt の投入、プロセスの回収
cordis.patch.yml        プラグインをプロファイルに組み込むオーバーレイ
src/main.mjs            Electron メインプロセス：ウィンドウ、メニュー、IPC、起動ガード
src/stdio-kernel.mjs    プラグインとの通信路：stdin/stdout で 1 行 1 JSON。stdout はプロトコル専用
src/state.mjs           セッションイベント -> キャラクター状態（純粋関数）
src/preload.cjs         描画層に公開する唯一の窓口
src/renderer/           見た目、アニメーション、吹き出し
```

```sh
npm run check           # 全ソースの構文チェック
```

キーワード：DeepSeek Harness · DSH プラグイン · デスクトップペット · desktop pet · Electron · 透明ウィンドウ · セッションイベント · 状態機械
