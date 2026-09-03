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

提示詞的任何改動都要在此記錄日期與原因。題目風格若在某段期間明顯不同，多半能在這張表裡找到解釋。

## 提示詞本文

```
每天為我準備一份英文學習教材，來源限以下兩個網站：
- https://learningenglish.voanews.com/ （優先）
- https://www.bbc.co.uk/learningenglish/ （備用）

步驟：

1. 先讀取我的 Google 試算表「English Learning」的 settings 分頁，
   取得 B1 儲存格的 current_level 值（CEFR 等級，例如 B1、B2）。

2. 讀取 lessons 分頁已有的所有 source_url，這些是用過的，不可重複選用。

3. 到上述來源找一篇「最近七天內發布、難度接近 current_level、
   且同頁附有完整逐字稿與音檔」的內容。找不到就往前多找幾天，
   仍找不到才改用備用來源。

4. 針對這篇內容產生下列材料，全部用英文，只有單字的中文釋義用繁體中文：

   - reading_text：文章或逐字稿的完整內容，純文字，不要保留網頁排版
   - reading_questions：4 題四選一閱讀理解題，
     其中 2 題問細節、1 題問主旨、1 題需要推論。
     格式為 JSON 陣列，每題結構為
     {"prompt":"題目","options":["A","B","C","D"],"answer_index":0,"explanation":"為什麼選這個，繁體中文"}
   - audio_url：該頁音檔的 MP3 直接連結
   - audio_start_sec / audio_end_sec：從音檔中選一段 120 到 180 秒的區間，
     起訖點要落在句子邊界，不可切在半句中間。填入整數秒數。
   - transcript：上述那段區間對應的逐字稿文字
   - listening_questions：針對該音檔區間出 3 題四選一，格式同 reading_questions
   - vocab：從本篇挑 8 到 12 個難度在 current_level 以上的字詞，
     格式為 JSON 陣列，每個結構為
     {"term":"字詞","pos":"詞性","definition_en":"英文釋義","definition_zh":"繁體中文釋義","example":"直接取自本篇原文的句子"}
     每個 term 都必須真的出現在本篇原文中，不可自行造字。

5. 把結果新增為 lessons 分頁的一列，欄位依序對應標題列。
   lesson_id 填今天日期，格式 YYYY-MM-DD。
   level 填這篇實際的難度。
   source 填 voa_le 或 bbc_le。
   generated_at 填現在時間。
   reading_questions、listening_questions、vocab 三欄請填入壓縮成單行的 JSON 字串。

6. 如果任何一步失敗（找不到合適文章、沒有逐字稿、沒有音檔），
   不要寫入不完整的資料。改為寄一封 email 給我說明卡在哪一步。
   
7.排程設定完先執行一次測試
```

## 設計理由

**第 1 步讀 `current_level` 而非寫死難度**：難度由網頁端依答對率回寫，Spark 每天讀最新值。這條路徑斷掉的話難度會永遠停在初始值。

**第 6 步寧可不產出也不寫半筆**：缺欄位的列在網頁端表現為「程式壞掉」，使用者無從分辨是內容缺漏還是程式錯誤，除錯成本遠高於少一天內容。

**單字要求「必須出現在原文中」**：語言模型會憑空造出看似合理的例句與詞條，這條限制配合驗證器的比對檢查可以攔下來。
