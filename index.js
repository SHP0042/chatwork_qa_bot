// 一時的な調査用エンドポイント。Q&A表の中身をそのまま確認するため。原因が分かったら削除してOK。
// ?gid=... または ?name=... を付けると、環境変数を変えずに一時的に別タブを確認できる。
// ?raw=1 を付けると、見出し行の自動判定を一切せず、指定した範囲の生データをそのまま返す
// （既定: 先頭6行×A〜F列、各セル30文字まで。?rowFrom=&rowTo=&colFrom=&colTo=&len= で調整可能）。
app.get('/debug-sheet', async (req, res) => {
  if (!checkSecret(req, res)) return;
  try {
    const overrideGid = req.query.gid;
    const overrideName = req.query.name;

    if (req.query.raw) {
      const title = await resolveFaqSheetTitle(overrideGid, overrideName);
      const sheets = await getSheets();
      const raw = await sheets.spreadsheets.values.get({
        spreadsheetId: config.sheetId,
        range: `${title}`,
      });
      const values = raw.data.values || [];
      // レスポンスを小さく保つため、既定では先頭6行×A〜F列のみ、各セルは30文字までに切り詰める。
      // ?rowFrom=&rowTo=&colFrom=&colTo=&len= で範囲を指定できる。
      const rowFrom = parseInt(req.query.rowFrom || '1', 10);
      const rowTo = parseInt(req.query.rowTo || '6', 10);
      const colFrom = req.query.colFrom ? colLetterToIndex(req.query.colFrom) : 0;
      const colTo = req.query.colTo ? colLetterToIndex(req.query.colTo) : 5;
      const len = parseInt(req.query.len || '30', 10);
      const slice = [];
      for (let i = rowFrom - 1; i < Math.min(rowTo, values.length); i++) {
        const row = values[i] || [];
        const cells = [];
        for (let j = colFrom; j <= colTo; j++) {
          const v = (row[j] || '').toString();
          cells.push({ col: indexToColLetter(j), value: v.slice(0, len) });
        }
        slice.push({ rowNumber: i + 1, cells });
      }
      res.json({ sheetTitle: title, rows: slice });
      return;
    }

    const { title, headerRowIndex, headerRow, questionColIndex, answerColIndex, answerColIndexes, rows } =
      await readFaqTable(overrideGid, overrideName);
    res.json({
      sheetTitle: title,
      headerRowNumber: headerRowIndex + 1,
      headerRow,
      questionColumn: indexToColLetter(questionColIndex),
      answerColumnPrimary: indexToColLetter(answerColIndex),
      answerColumnsAll: answerColIndexes.map(indexToColLetter),
      rowCount: rows.length,
      rows: rows.map((r) => ({
        rowNumber: r.rowNumber,
        question: r.question,
        questionNormalized: normalizeForMatch(r.question),
        answerPreview: (r.answer || '').slice(0, 60),
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});
