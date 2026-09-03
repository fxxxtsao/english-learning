# Gemini Spark 每日教材生成提示詞

**用途**：貼進 Gemini Spark 建立每日排程任務，自動產生一天份的英文練習教材寫入 Google Sheets。

**前置需求**
- Google AI Pro 或 Ultra 訂閱（Spark 的使用條件）
- 一份名為「English Learning」的 Google 試算表，含 `lessons` 與 `settings` 兩個分頁，欄位定義見 `docs/specs/2026-09-02-content-pipeline.md`
- 排程設定：每日早上執行一次

## 版本紀錄

| 日期 | 變更 |
|---|---|
| 2026-09-02 | 初版 |
| 2026-09-03 | 首次實跑後修正：Spark 完成了全部生成工作，卻獨獨沒寫入 `reading_text` 與 `transcript` 兩個最長的欄位（14 個必填欄位中只有這 2 個是空的）。將寫入拆成兩步、並明文禁止省略或摘要長文字 |
| 2026-09-03 | **來源改為 RSS feed，並取消發布日期限制**。實測發現兩件事：(1) VOA 文章頁的音檔由動態腳本載入，Spark 取不到 MP3 直連；(2) VOA Learning English 自 2025 年 3 月起已停止產出新內容（三個獨立 feed 分別停在 3/11、3/14、3/31），原本「最近七天內發布」的條件永遠無法滿足。改為讀 RSS feed（每則項目直接附 MP3 網址與文章頁連結），並改從 VOA 存量中挑選未使用過的文章，BBC 降為存量用盡時的備援 |

提示詞的任何改動都要在此記錄日期與原因。題目風格若在某段期間明顯不同，多半能在這張表裡找到解釋。

## 提示詞本文

```
每天為我準備一份英文學習教材。

步驟：

1. 先讀取我的 Google 試算表「English Learning」的 settings 分頁，
   取得 B1 儲存格的 current_level 值（CEFR 等級，例如 B1、B2）。

2. 讀取 lessons 分頁已有的所有 source_url，這些是用過的，不可重複選用。

3. 到下列 RSS feed 找教材。這些 feed 的每一則項目都同時附有音檔的
   直接下載網址與對應的文章頁連結，請一律從 feed 取得音檔網址，
   不要去文章頁面的播放器裡找 —— 那是動態載入的，抓不到。

   優先來源（VOA Learning English，美國政府作品，公眾領域）：
   - https://learningenglish.voanews.com/podcast/?zoneId=955&count=100&format=RSS
   - https://learningenglish.voanews.com/podcast/?zoneId=1579&count=100&format=RSS
   - https://learningenglish.voanews.com/podcast/?zoneId=1574&count=100&format=RSS

   VOA 自 2025 年 3 月起已停止產出新內容，只剩存量。
   因此「不要」限定發布日期，也不要因為文章不是最近的就跳過。
   請從上述 feed 的存量中，挑一則尚未用過、難度接近 current_level 的即可。

   備用來源（BBC Learning English，仍持續更新）：
   只有當上述三個 feed 裡已經找不到未使用過的合適內容時，
   才改到 https://www.bbc.co.uk/learningenglish/ 的 6 Minute English，
   該站每一集的頁面都附有逐字稿與音檔下載連結。

4. 從選中的 RSS 項目取得這兩個值：
   - audio_url：該項目 enclosure 標籤裡的 MP3 網址，原封不動照抄，不要改寫或縮短
   - source_url：該項目的文章頁連結
   接著開啟該文章頁，取得完整逐字稿。
   如果那一頁沒有逐字稿，就換下一則，不要硬湊、不要自己生成逐字稿。

5. 針對這篇內容產生下列材料，全部用英文，只有單字的中文釋義用繁體中文：

   - reading_text：文章或逐字稿的完整內容，純文字，不要保留網頁排版
   - reading_questions：4 題四選一閱讀理解題，
     其中 2 題問細節、1 題問主旨、1 題需要推論。
     格式為 JSON 陣列，每題結構為
     {"prompt":"題目","options":["A","B","C","D"],"answer_index":0,"explanation":"為什麼選這個，繁體中文"}
   - audio_start_sec / audio_end_sec：從音檔中選一段 120 到 180 秒的區間，
     起訖點要落在句子邊界，不可切在半句中間。填入整數秒數。
   - transcript：上述那段區間對應的逐字稿文字
   - listening_questions：針對該音檔區間出 3 題四選一，格式同 reading_questions
   - vocab：從本篇挑 8 到 12 個難度在 current_level 以上的字詞，
     格式為 JSON 陣列，每個結構為
     {"term":"字詞","pos":"詞性","definition_en":"英文釋義","definition_zh":"繁體中文釋義","example":"直接取自本篇原文的句子"}
     每個 term 都必須真的出現在本篇原文中，不可自行造字。

6. 寫入分成兩個步驟，請確實分開執行，不要合併：

   步驟 6a：先在 lessons 分頁新增一列，填入除了 reading_text 與 transcript
   以外的所有欄位，欄位依序對應標題列。
   lesson_id 填今天日期，格式 YYYY-MM-DD，且必須以純文字寫入，
   不要讓試算表把它變成日期格式。
   level 填這篇實際的難度。
   source 填 voa_le 或 bbc_le。
   generated_at 填現在時間。
   reading_questions、listening_questions、vocab 三欄請填入壓縮成單行的 JSON 字串。

   步驟 6b：接著把剛才那一列的 F 欄（reading_text）與 K 欄（transcript）
   分別補寫進去。這兩欄是整份教材裡最長的內容，
   必須寫入完整全文，不可以摘要、不可以只寫前幾段、不可以留空。
   如果一次寫不進去，就一欄一欄分開寫，寫完後回頭確認兩個儲存格
   都確實有內容，再繼續下一步。

   兩個步驟都完成後，請告訴我這一列實際寫在第幾列，
   以及 F 欄與 K 欄各自的字元數，好讓我確認沒有被截斷。

7. 如果任何一步失敗（找不到合適文章、沒有逐字稿、沒有音檔網址），
   不要寫入不完整的資料。改為寄一封 email 給我說明卡在哪一步，
   並附上你嘗試過的 feed 與文章網址。
```

## 設計理由

**第 1 步讀 `current_level` 而非寫死難度**：難度由網頁端依答對率回寫，Spark 每天讀最新值。這條路徑斷掉的話難度會永遠停在初始值。

**第 6 步寧可不產出也不寫半筆**：缺欄位的列在網頁端表現為「程式壞掉」，使用者無從分辨是內容缺漏還是程式錯誤，除錯成本遠高於少一天內容。

**單字要求「必須出現在原文中」**：語言模型會憑空造出看似合理的例句與詞條，這條限制配合驗證器的比對檢查可以攔下來。

**音檔網址一律取自 RSS 的 enclosure，不從文章頁抓**：VOA 文章頁的播放器是動態腳本載入的，模型讀 HTML 讀不到 MP3 網址——首次實跑就卡在這一步。RSS 是為機器讀取而設計的格式，音檔網址是規格明定的欄位，穩定得多。附帶好處是 feed 的項目連結天然對應到該篇文章頁，音檔與逐字稿的配對不會錯位。

**取消「最近七天內發布」**：VOA 已停更，這個條件會讓每天的搜尋必然落空。改為「從存量中挑未用過的」之後，光三個分類 feed 就有約 600 則，接近兩年份的每日教材。對語言學習而言，文章是去年或今年寫的並不影響練習價值，供應穩定才影響。

**寫入拆成兩步**：合併成一次寫入時，模型會完成所有生成工作卻獨獨放掉最長的兩個欄位（實測結果）。拆開之後它沒有可以省略的餘地，而要求回報字元數則是為了讓「被截斷」跟「寫成功」區分得出來——這兩者在試算表上看起來一模一樣。
